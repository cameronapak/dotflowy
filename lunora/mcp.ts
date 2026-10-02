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

async function assertWritable(ctx: MutationCtx): Promise<void> {
  if ((await ctx.db.query("retirementState").collect()).length > 0) {
    throw new Error("LUNORA_RETIRED");
  }
}

async function commitPlan(ctx: MutationCtx, plan: OutlinePlan): Promise<void> {
  // Write through the per-table facade (`ctx.db.nodes`), which forwards its
  // table name as `expectedTable` and scopes the runtime id lookup to one
  // table. The bare `ctx.db.delete`/`ctx.db.patch` are safe only with an
  // explicit positional `expectedTable` (mutators.ts uses that form). Without
  // it the lookup builds a UNION ALL across every shard table and trips
  // Workerd SQLite's compound-SELECT limit ("too many terms in compound
  // SELECT"). `asId` is compile-time branding only and does not scope.
  for (const id of plan.deletes) {
    await ctx.db.nodes.delete(id as Id<"nodes">);
  }
  for (const patch of plan.patches) {
    await ctx.db.nodes.patch(
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
    await assertWritable(ctx);
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
    await assertWritable(ctx);
    const existing = await ctx.db
      .query("dailyIndex")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    const current =
      existing && typeof existing.nodeId === "string" ? existing.nodeId : null;
    const { winner, won } = resolveDailyClaim(current, args.nodeId);
    if (existing) {
      // Facade patch, not bare `ctx.db.patch` — see commitPlan. This site is
      // the one every date-resolving MCP tool hits (the "container" key always
      // exists after first use), so an unscoped patch here broke them all.
      await ctx.db.dailyIndex.patch(existing._id as Id<"dailyIndex">, {
        nodeId: winner,
        touchedAt: args.touchedAt,
      });
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
  "retirementState",
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

async function exportRetirementSnapshot(
  ctx: QueryCtx | MutationCtx,
  userId: string,
) {
  const [nodes, dailyIndex, tagColors, savedQueries, migrateState] =
    await Promise.all([
      ctx.db.query("nodes").collect(),
      ctx.db.query("dailyIndex").collect(),
      ctx.db.query("tagColors").collect(),
      ctx.db.query("savedQueries").collect(),
      ctx.db.query("migrateState").collect(),
    ]);
  return {
    version: 1,
    exportedAt: Date.now(),
    userId,
    nodes: nodes.map((row) => ({ ...docToNode(row), userId })),
    dailyIndex: dailyIndex.map((row) => ({
      key: String(row.key),
      nodeId: String(row.nodeId),
      touchedAt: Number(row.touchedAt),
      userId: String(row.userId),
    })),
    tagColors: tagColors.map((row) => ({
      tag: String(row.tag),
      color: String(row.color),
      userId: String(row.userId),
    })),
    savedQueries: savedQueries.map((row) => ({
      id: String(row._id),
      name: String(row.name),
      query: String(row.query),
      createdAt: Number(row.createdAt),
      userId: String(row.userId),
    })),
    migrateState: migrateState.map((row) => ({
      nodesAt: typeof row.nodesAt === "number" ? row.nodesAt : null,
      kvAt: typeof row.kvAt === "number" ? row.kvAt : null,
      userId: String(row.userId),
    })),
  };
}

/** Consistent dry-run export. No write fence is installed. */
export const inspectRetirement = internalQuery
  .input({ userId: v.string() })
  .query(async ({ ctx, args }) => {
    const retirement = await ctx.db.query("retirementState").collect();
    return {
      retirement: retirement[0]
        ? {
            migrationId: String(retirement[0].migrationId),
            status: String(retirement[0].status),
            updatedAt: Number(retirement[0].updatedAt),
          }
        : null,
      snapshot: await exportRetirementSnapshot(ctx, args.userId),
    };
  });

/** Install the shard write fence and export every content table atomically. */
export const freezeAndExportRetirement = internalMutation
  .input({ userId: v.string(), migrationId: v.string(), now: v.number() })
  .mutation(async ({ ctx, args }) => {
    const rows = await ctx.db.query("retirementState").collect();
    const existing = rows[0];
    if (rows.length > 1) throw new Error("multiple Lunora retirement rows");
    if (existing) {
      if (existing.migrationId !== args.migrationId) {
        throw new Error("Lunora shard is fenced by another migration");
      }
    } else {
      await ctx.db.insert("retirementState", {
        userId: args.userId,
        migrationId: args.migrationId,
        status: "frozen",
        updatedAt: args.now,
      });
    }
    return exportRetirementSnapshot(ctx, args.userId);
  });

export const releaseRetirementFreeze = internalMutation
  .input({ userId: v.string(), migrationId: v.string() })
  .mutation(async ({ ctx, args }) => {
    const rows = await ctx.db.query("retirementState").collect();
    const existing = rows[0];
    if (!existing) return { released: true };
    if (existing.migrationId !== args.migrationId) {
      throw new Error("Lunora shard is fenced by another migration");
    }
    if (existing.status === "retired") {
      throw new Error("retired Lunora shard cannot be unfrozen");
    }
    await ctx.db.retirementState.delete(existing._id as Id<"retirementState">);
    return { released: true };
  });

export const markRetirementVerified = internalMutation
  .input({ userId: v.string(), migrationId: v.string(), now: v.number() })
  .mutation(async ({ ctx, args }) => {
    const rows = await ctx.db.query("retirementState").collect();
    const existing = rows[0];
    if (!existing || existing.migrationId !== args.migrationId) {
      throw new Error("matching Lunora retirement fence is required");
    }
    await ctx.db.retirementState.patch(existing._id as Id<"retirementState">, {
      status: "retired",
      updatedAt: args.now,
    });
    return { retired: true };
  });
