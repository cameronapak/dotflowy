/**
 * Worker MCP ↔ Lunora bridge (LUNORA_OUTLINE=1).
 *
 * Regular `mutation`/`query` (not watermarked `defineMutator`) so the Worker
 * can call them via trusted shard RPC without clientSeq headers. Browser
 * editor keeps using fine-grained mutators; MCP keeps outline-ops planners.
 */

import type { Id } from "./_generated/dataModel";

import {
  docToNode,
  nodeToInsertFields,
  planFromChangeOps,
  type OutlinePlan,
} from "../src/data/outline-plans";
import { internalMutation, internalQuery, v } from "./_generated/server";

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

type ShardTable = "nodes" | "tagColors" | "savedQueries" | "dailyIndex";

type MutatorDb = {
  query: (table: ShardTable) => {
    collect: () => Promise<Array<Record<string, unknown> & { _id: string }>>;
  };
  get: (
    id: Id<ShardTable>,
  ) => Promise<(Record<string, unknown> & { _id: string }) | null>;
  insert: (
    table: ShardTable,
    document: Record<string, unknown>,
    options?: { clientId?: string },
  ) => Promise<string>;
  patch: (id: Id<ShardTable>, fields: Record<string, unknown>) => Promise<void>;
  delete: (id: Id<ShardTable>) => Promise<void>;
};

type MutatorCtx = {
  auth: { userId?: string | null };
  db: MutatorDb;
};

function assertOwner(ctx: MutatorCtx, userId: string): void {
  if (ctx.auth.userId !== userId) {
    throw new Error("unauthorized: shard userId mismatch");
  }
}

async function commitPlan(ctx: MutatorCtx, plan: OutlinePlan): Promise<void> {
  for (const id of plan.deletes) {
    await ctx.db.delete(id as Id<"nodes">);
  }
  for (const patch of plan.patches) {
    await ctx.db.patch(
      patch.id as Id<"nodes">,
      patch.fields as Record<string, unknown>,
    );
  }
  for (const node of plan.inserts) {
    await ctx.db.insert("nodes", nodeToInsertFields(node), {
      clientId: node.id,
    });
  }
}

const wireNodeArg = v.object({
  id: v.string(),
  parentId: v.string().nullable(),
  prevSiblingId: v.string().nullable(),
  text: v.string(),
  isTask: v.boolean(),
  completed: v.boolean(),
  collapsed: v.boolean(),
  bookmarkedAt: v.number().nullable(),
  mirrorOf: v.string().nullable(),
  createdAt: v.number(),
  updatedAt: v.number(),
  origin: v.string().nullable(),
  kind: v.literal("paragraph").nullable(),
});

const changeOpArg = v.union(
  v.object({ op: v.literal("insert"), value: wireNodeArg }),
  v.object({ op: v.literal("update"), value: wireNodeArg }),
  v.object({ op: v.literal("delete"), key: v.string() }),
);

/** Full outline for MCP get_outline / search_nodes. Worker-only (system RPC). */
export const listNodes = internalQuery
  .input({ userId: v.string() })
  .query(async ({ ctx, args }): Promise<McpNode[]> => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const rows = await mctx.db.query("nodes").collect();
    return rows.map((row) => {
      const n = docToNode(row);
      const { userId: _u, ...wire } = n;
      return wire;
    });
  });

/** Daily-index rows for MCP claimDailyScaffold. Worker-only (system RPC). */
export const listDailyIndex = internalQuery
  .input({ userId: v.string() })
  .query(async ({ ctx, args }) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const rows = await mctx.db.query("dailyIndex").collect();
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
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    if (args.ops.length === 0) return { count: 0 };
    const plan = planFromChangeOps(args.userId, args.ops);
    await commitPlan(mctx, plan);
    return {
      count: args.ops.length,
      deletes: plan.deletes.length,
      inserts: plan.inserts.length,
      patches: plan.patches.length,
    };
  });
