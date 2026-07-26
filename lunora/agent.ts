/// <reference types="@cloudflare/workers-types" />

/**
 * Inline `@agent` fire action (ADR 0059).
 *
 * Plain Lunora action (not `@lunora/workflow` / `@lunora/agent`): Workers AI
 * tool loop via `@lunora/ai` `streamText`, cooperative cancel between patches,
 * paid-plan gate via `getPlan` before burning AI. Workflow deferred — see
 * HANDOFF.md.
 */

import { streamText } from "@lunora/ai";
import { rateLimit } from "lunorash/ratelimit";

import { splitAgentAnswer } from "../src/data/agent-answer";
import { buildAgentMessages } from "../src/data/agent-messages";
import { buildAgentPrompt } from "../src/data/agent-prompt";
import { buildTreeIndex } from "../src/data/tree";
import { getPlan, PAID_PLANS, type Plan } from "../worker/plan";
import { action, v } from "./_generated/server";
import { buildAgentAiTools } from "./agent-ai-tools";
import { createActionOutlineStore } from "./agent-outline-store";
import {
  commitAgentAnswer,
  createAgentRun,
  failAgentRun,
  getAgentRun,
  patchAgentRunPartial,
} from "./mutators";
import { makeRateLimiter } from "./ratelimit/schema";

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
 * Note: ActionCtx.runMutation is typed for `RegisteredMutation`, while
 * `defineMutator` yields `RegisteredMutator`. Cast with `as never` until Lunora
 * widens the overload.
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
    rateLimit((ctx) => makeRateLimiter(ctx), "agent", {
      key: (ctx) => ctx.auth.userId ?? "anon",
    }),
  )
  .action(async ({ ctx, args }) => {
    if (ctx.auth.userId !== args.userId) {
      throw new Error("unauthorized");
    }

    // Paid-plan gate BEFORE createAgentRun / Workers AI (fail closed).
    const plan = await getPlan(args.userId, {
      DB: resolveBillingDb(ctx.env),
    });
    if (!isPaidPlan(plan)) {
      throw new Error("Inline agent requires a paid plan");
    }

    const now = Date.now();
    const created = (await ctx.runMutation(createAgentRun as never, {
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
      await ctx.runMutation(failAgentRun as never, {
        userId: args.userId,
        runId,
        error,
        updatedAt: Date.now(),
      });
      return { runId, status: "error" as const };
    };

    const stillRunning = async (): Promise<boolean> => {
      const live = (await ctx.runMutation(getAgentRun as never, {
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
      const result = streamText({
        model: ctx.ai.model(AGENT_MODEL),
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
          await ctx.runMutation(patchAgentRunPartial as never, {
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
        await ctx.runMutation(patchAgentRunPartial as never, {
          userId: args.userId,
          runId,
          partialText: finalText,
          updatedAt: Date.now(),
        });
      }

      const { summary, detail } = splitAgentAnswer(finalText);
      const commitResult = (await ctx.runMutation(commitAgentAnswer as never, {
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
      })) as { ok: boolean; answerRootId?: string; error?: string };

      if (!commitResult.ok) {
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
