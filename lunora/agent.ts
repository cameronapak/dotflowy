/**
 * Inline `@agent` fire action (ADR 0059).
 *
 * v1 stub: creates a run, streams canned partial text for ghost UI, then
 * commits summary+detail via `commitAgentAnswer` (one mutator transaction).
 * Real Workers AI + restricted tool loop is the next slice.
 */

import { rateLimit } from "lunorash/ratelimit";

import { action, v } from "./_generated/server";
import {
  commitAgentAnswer,
  createAgentRun,
  failAgentRun,
  getAgentRun,
  patchAgentRunPartial,
} from "./mutators";
import { makeRateLimiter } from "./ratelimit/schema";

/**
 * Fire (or re-fire) an `@agent` question. Paid-plan gate + AI Gateway land in
 * a follow-up; the client only calls this when upgraded sync is ON.
 *
 * Note: ActionCtx.runMutation is typed for `RegisteredMutation`, while
 * `defineMutator` yields `RegisteredMutator`. Both share `kind: "mutation"` +
 * `handler` and the DO dispatches them the same way — cast with `as never`
 * until Lunora widens the overload.
 */
export const fireAgentRun = action
  .input({
    userId: v
      .string()
      .check((s) => s.length > 0 && s.length <= 128, {
        schema: { minLength: 1, maxLength: 128 },
      }),
    questionNodeId: v
      .string()
      .check((s) => s.length > 0 && s.length <= 64, {
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
    const canned = "This is a stub agent reply. The real tool loop lands next.";
    const detail =
      "Streaming + Workers AI + the restricted tool allowlist will replace this canned answer.";

    for (let i = 8; i <= canned.length; i += 12) {
      const live = (await ctx.runMutation(getAgentRun as never, {
        userId: args.userId,
        runId,
      })) as { status: string } | null;
      if (!live || live.status !== "running") {
        return { runId, status: "cancelled" as const };
      }
      await ctx.runMutation(patchAgentRunPartial as never, {
        userId: args.userId,
        runId,
        partialText: canned.slice(0, i),
        updatedAt: Date.now(),
      });
    }

    const live = (await ctx.runMutation(getAgentRun as never, {
      userId: args.userId,
      runId,
    })) as { status: string } | null;
    if (!live || live.status !== "running") {
      return { runId, status: "cancelled" as const };
    }

    const result = (await ctx.runMutation(commitAgentAnswer as never, {
      userId: args.userId,
      runId,
      questionNodeId: args.questionNodeId,
      summaryText: canned,
      detailText: detail,
      priorAnswerRootId: created.answerRootId,
      priorAnswerHash: created.answerHash,
      summaryId: crypto.randomUUID(),
      detailId: crypto.randomUUID(),
      updatedAt: Date.now(),
    })) as { ok: boolean; answerRootId?: string; error?: string };

    if (!result.ok) {
      await ctx.runMutation(failAgentRun as never, {
        userId: args.userId,
        runId,
        error: result.error ?? "commit failed",
        updatedAt: Date.now(),
      });
      return { runId, status: "error" as const };
    }

    return {
      runId,
      status: "completed" as const,
      answerRootId: result.answerRootId,
    };
  });
