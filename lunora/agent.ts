/// <reference types="@cloudflare/workers-types" />

/**
 * Inline `@agent` fire action (ADR 0059).
 *
 * Plain Lunora action (not `@lunora/workflow` / `@lunora/agent`): Workers AI
 * tool loop via `@lunora/ai` `streamText`, cooperative cancel between patches,
 * paid-plan gate via `getPlan` before burning AI. Workflow deferred until a
 * real need clears the ~10-minute action ceiling.
 */

import { streamText } from "@lunora/ai";
import { rateLimit } from "lunorash/ratelimit";

import { splitAgentAnswer } from "../src/data/agent-answer";
import {
  AGENT_SYSTEM_PROMPT,
  buildAgentMessages,
} from "../src/data/agent-messages";
import { buildAgentPrompt } from "../src/data/agent-prompt";
import { buildTreeIndex } from "../src/data/tree";
import { getPlan, PAID_PLANS, type Plan } from "../worker/plan";
import { api } from "./_generated/api";
import { action, v } from "./_generated/server";
import { buildAgentAiTools } from "./agent-ai-tools";
import { createActionOutlineStore } from "./agent-outline-store";
import { makeRateLimiter } from "./ratelimit/schema";

/**
 * Mutators aren't listed on generated ApiTypes (client watermark path), but
 * `api` is `anyApi` — `api.mutators.<name>.__lunoraRef` is `"mutators:<name>"`.
 * Importing defineMutator exports directly leaves `__lunoraRef` undefined and
 * `ctx.runMutation` throws `unknown function: undefined` → client "internal error".
 */
type AgentMutatorApi = {
  mutators: {
    createAgentRun: never;
    failAgentRun: never;
    getAgentRun: never;
    patchAgentRunPartial: never;
    commitAgentAnswer: never;
  };
};
const agentMutators = (api as unknown as AgentMutatorApi).mutators;

/** Workers AI model (ADR 0059 / Cam lock). Gateway via LUNORA_AI_GATEWAY_* env. */
const AGENT_MODEL = "@cf/zai-org/glm-4.7-flash";

/** Cap tool-loop steps so a stuck model can't burn the action ceiling. */
const AGENT_MAX_STEPS = 8;

/** Throttle ghost-text patches (ms). */
const PARTIAL_PATCH_MS = 200;

function isPaidPlan(plan: Plan): boolean {
  return (PAID_PLANS as readonly string[]).includes(plan);
}

type BillingEnv = { DB?: D1Database };

function resolveBillingDb(
  env: Record<string, unknown> | undefined,
): D1Database {
  const db = (env as BillingEnv | undefined)?.DB;
  if (!db) {
    throw new Error("billing unavailable");
  }
  return db;
}

/**
 * Fire (or re-fire) an `@agent` question. Client only calls when upgraded sync
 * is ON. Paid plans only — fail closed before creating a run / calling AI.
 *
 * Note: ActionCtx.runMutation wants FunctionReference; mutator refs from anyApi
 * are typed narrowly here until Lunora widens the overload.
 */
export const fireAgentRun = action
  .input({
    userId: v.string().check((s) => s.length > 0 && s.length <= 128, {
      schema: { minLength: 1, maxLength: 128 },
    }),
    questionNodeId: v.string().check((s) => s.length > 0 && s.length <= 64, {
      schema: { minLength: 1, maxLength: 64 },
    }),
  })
  .use(
    // Durable `ratelimit_buckets` via createDbStore; expectedTable-scoped
    // patch/delete (lunora/ratelimit/scope-db.ts) avoids UNION ALL blow-up.
    // Per-call limiter is fine — bucket state lives in the DO, not the isolate.
    rateLimit((ctx) => makeRateLimiter(ctx), "agent", {
      key: (ctx) => ctx.auth.userId ?? "anon",
    }),
  )
  .action(async ({ ctx, args }) => {
    if (ctx.auth.userId !== args.userId) {
      throw new Error("unauthorized");
    }

    // Paid-plan gate BEFORE createAgentRun / Workers AI (fail closed).
    // `ctx.env.DB` requires `lunora/env.ts` defineEnv (codegen) — without it
    // Lunora leaves `ctx.env` empty and we throw "billing unavailable".
    const plan = await getPlan(args.userId, {
      DB: resolveBillingDb(ctx.env as Record<string, unknown> | undefined),
    });
    if (!isPaidPlan(plan)) {
      throw new Error("Inline agent requires a paid plan");
    }

    const now = Date.now();
    const created = (await ctx.runMutation(agentMutators.createAgentRun, {
      userId: args.userId,
      questionNodeId: args.questionNodeId,
      createdAt: now,
    })) as {
      runId: string;
      reused: boolean;
      answerRootId: string | null;
      answerHash: string | null;
    };

    if (created.reused) {
      return { runId: created.runId, status: "running" as const };
    }

    const runId = created.runId;

    const fail = async (error: string) => {
      await ctx.runMutation(agentMutators.failAgentRun, {
        userId: args.userId,
        runId,
        error,
        updatedAt: Date.now(),
      });
      return { runId, status: "error" as const, error };
    };

    const stillRunning = async (): Promise<boolean> => {
      const live = (await ctx.runMutation(agentMutators.getAgentRun, {
        userId: args.userId,
        runId,
      })) as { status: string } | null;
      return !!live && live.status === "running";
    };

    try {
      const store = createActionOutlineStore(ctx, args.userId);
      const nodes = await store.getNodes();
      const index = buildTreeIndex(nodes);
      if (!index.byId.has(args.questionNodeId)) {
        return await fail("question node missing");
      }

      const prompt = buildAgentPrompt(index, args.questionNodeId);
      const messages = buildAgentMessages(prompt);
      const abort = new AbortController();
      const agentTools = buildAgentAiTools(store, {
        isCancelled: async () => {
          const ok = await stillRunning();
          if (!ok) abort.abort();
          return !ok;
        },
      });

      // Tool schemas are Effect→JSON; cast past AI SDK ToolSet generics (two
      // nested `ai` copies in the graph make the typed overload unusable).
      // AI SDK: system copy must be `instructions`, not role:"system" in messages
      // (InvalidPromptError → empty stream → "nothing happened" in the UI).
      const result = streamText({
        model: ctx.ai.model(AGENT_MODEL),
        instructions: AGENT_SYSTEM_PROMPT,
        messages,
        tools: agentTools,
        abortSignal: abort.signal,
        // Inline stop — avoid importing `stepCountIs` from a second `ai` copy.
        stopWhen: ({ steps }: { steps: unknown[] }) =>
          steps.length >= AGENT_MAX_STEPS,
        maxOutputTokens: 2048,
      } as Parameters<typeof streamText>[0]);

      let buffer = "";
      let lastPatchAt = 0;

      for await (const delta of result.textStream) {
        if (!(await stillRunning())) {
          abort.abort();
          return { runId, status: "cancelled" as const };
        }
        buffer += delta;
        const t = Date.now();
        if (t - lastPatchAt >= PARTIAL_PATCH_MS) {
          lastPatchAt = t;
          await ctx.runMutation(agentMutators.patchAgentRunPartial, {
            userId: args.userId,
            runId,
            partialText: buffer,
            updatedAt: t,
          });
        }
      }

      const finalText = (await result.text).trim() || buffer.trim();
      if (!(await stillRunning())) {
        return { runId, status: "cancelled" as const };
      }

      if (finalText && finalText !== buffer) {
        await ctx.runMutation(agentMutators.patchAgentRunPartial, {
          userId: args.userId,
          runId,
          partialText: finalText,
          updatedAt: Date.now(),
        });
      }

      const { summary, detail } = splitAgentAnswer(finalText);
      const commitResult = (await ctx.runMutation(
        agentMutators.commitAgentAnswer,
        {
          userId: args.userId,
          runId,
          questionNodeId: args.questionNodeId,
          summaryText: summary,
          detailText: detail,
          priorAnswerRootId: created.answerRootId,
          priorAnswerHash: created.answerHash,
          summaryId: crypto.randomUUID(),
          detailId: crypto.randomUUID(),
          updatedAt: Date.now(),
        },
      )) as { ok: boolean; answerRootId?: string; error?: string };

      if (!commitResult.ok) {
        if (commitResult.error === "cancelled") {
          return { runId, status: "cancelled" as const };
        }
        return await fail(commitResult.error ?? "commit failed");
      }

      return {
        runId,
        status: "completed" as const,
        answerRootId: commitResult.answerRootId,
      };
    } catch (err) {
      if (!(await stillRunning())) {
        return { runId, status: "cancelled" as const };
      }
      const message = err instanceof Error ? err.message : String(err);
      return await fail(message.slice(0, 500));
    }
  });
