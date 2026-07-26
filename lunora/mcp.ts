/**
 * Worker MCP ↔ Lunora bridge (LUNORA_OUTLINE=1).
 *
 * Regular `mutation`/`query` (not watermarked `defineMutator`) so the Worker
 * can call them via trusted shard RPC without clientSeq headers. Browser
 * editor keeps using fine-grained mutators; MCP keeps outline-ops planners.
 */

import {
  docToNode,
  nodeToInsertFields,
  planFromChangeOps,
  type OutlinePlan,
} from "../src/data/outline-plans";
import { resolveDailyClaim } from "../src/plugins/daily/claim-mapping";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
  v,
} from "./_generated/server";
import { changeOpArg } from "./wire-args";

/** Wire node shape for MCP (no Lunora `userId`) — keeps codegen out of `src/`. */
type McpNode = {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: boolean;
  completed: boolean;
  collapsed: boolean;
  bookmarkedAt: number | null;
  mirrorOf: string | null;
  createdAt: number;
  updatedAt: number;
  origin: string | null;
  kind: "paragraph" | null;
};

function assertOwner(ctx: QueryCtx | MutationCtx, userId: string): void {
  if (ctx.auth.userId !== userId) {
    throw new Error("unauthorized: shard userId mismatch");
  }
}

async function commitPlan(ctx: MutationCtx, plan: OutlinePlan): Promise<void> {
  for (const id of plan.deletes) {
    // expectedTable avoids cross-table UNION ALL id lookup (Workerd SQLite
    // compound-SELECT limit — same footgun as lunora/mutators.ts).
    await ctx.db.delete(ctx.db.asId("nodes", id), "nodes");
  }
  for (const patch of plan.patches) {
    await ctx.db.patch(
      ctx.db.asId("nodes", patch.id),
      patch.fields as Record<string, unknown>,
      "nodes",
    );
  }
  for (const node of plan.inserts) {
    await ctx.db.insert("nodes", nodeToInsertFields(node), {
      clientId: node.id,
    });
  }
}

/** Full outline for MCP get_outline / search_nodes. */
export const listNodes = internalQuery
  .input({ userId: v.string() })
  .query(async ({ ctx, args }): Promise<McpNode[]> => {
    assertOwner(ctx, args.userId);
    const rows = await ctx.db.query("nodes").collect();
    return rows.map((row) => {
      const n = docToNode(row);
      const { userId: _u, ...wire } = n;
      return wire;
    });
  });

/** Daily-index rows for MCP claimDailyScaffold. */
export const listDailyIndex = internalQuery
  .input({ userId: v.string() })
  .query(async ({ ctx, args }) => {
    assertOwner(ctx, args.userId);
    const rows = await ctx.db.query("dailyIndex").collect();
    return rows.map((r) => ({
      key: String(r.key ?? r._id),
      nodeId: String(r.nodeId ?? ""),
    }));
  });

/**
 * Apply classic `ChangeOp[]` (outline-ops planners) as one shard transaction.
 * Worker-only via `x-lunora-system` — not a browser mutator path.
 * Spoiler redaction stays on MCP egress; daily claims use claimDailyMapping.
 */
export const applyChangeOps = internalMutation
  .input({
    userId: v.string(),
    ops: v.array(changeOpArg),
  })
  .mutation(async ({ ctx, args }) => {
    assertOwner(ctx, args.userId);
    if (args.ops.length === 0) {
      return { count: 0, deletes: 0, inserts: 0, patches: 0 };
    }
    const plan = planFromChangeOps(args.userId, args.ops);
    await commitPlan(ctx, plan);
    return {
      count: args.ops.length,
      deletes: plan.deletes.length,
      inserts: plan.inserts.length,
      patches: plan.patches.length,
    };
  });

export const claimDailyMapping = internalMutation
  .input({
    userId: v.string(),
    key: v.string(),
    nodeId: v.string(),
    touchedAt: v.number(),
  })
  .mutation(async ({ ctx, args }) => {
    assertOwner(ctx, args.userId);
    const existing = await ctx.db
      .query("dailyIndex")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    const current =
      existing && typeof existing.nodeId === "string" ? existing.nodeId : null;
    const { winner, won } = resolveDailyClaim(current, args.nodeId);
    if (existing) {
      await ctx.db.patch(
        ctx.db.asId("dailyIndex", existing._id),
        {
          nodeId: winner,
          touchedAt: args.touchedAt,
        },
        "dailyIndex",
      );
    } else {
      await ctx.db.insert("dailyIndex", {
        key: args.key,
        nodeId: winner,
        touchedAt: args.touchedAt,
        userId: ctx.auth.userId!,
      });
    }
    return { nodeId: winner, won };
  });

const CONTENT_TABLES = [
  "nodes",
  "tagColors",
  "savedQueries",
  "dailyIndex",
  "migrateState",
] as const;

/**
 * Erase every row in this user's shard (outline + side-collections). Worker-only
 * via system RPC — self-serve account deletion (ADR 0051 + ADR 0058).
 * Keyed by Better Auth `user.id` (same shard the browser/MCP mutators use).
 */
export const wipeUserShard = internalMutation
  .input({ userId: v.string() })
  .mutation(async ({ ctx, args }) => {
    void args.userId;
    return ctx.db.wipeShard({ tables: CONTENT_TABLES });
  });
