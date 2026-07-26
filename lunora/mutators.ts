import { defineMutator, v } from "lunorash/server";

import type { Id } from "./_generated/dataModel";

import {
  hashAnswerSubtree,
  shouldReplaceAnswer,
} from "../src/data/agent-replace-guard";
import {
  applyPlan,
  buildTreeIndex,
  docToNode,
  emptyPlan,
  nodeToInsertFields,
  planAppendChild,
  planFromChangeOps,
  planIndent,
  planIndentMany,
  planInsertChildAtStart,
  planInsertSibling,
  planMaterializeDailyNodes,
  planMirrorNode,
  planMoveMany,
  planMoveNode,
  planOutdent,
  planOutdentMany,
  planRemoveMany,
  planRemoveNode,
  planRestoreNodes,
  planSeedIfEmpty,
  planSetBookmarkedAt,
  planSetCollapsed,
  planSetCompleted,
  planSetIsTask,
  planSetKind,
  planSetText,
  planSplitNode,
  type OutlineNode,
  type OutlinePlan,
} from "../src/data/outline-plans";
import { resolveDailyClaim } from "../src/plugins/daily/claim-mapping";
import { changeOpArg } from "./wire-args";

type ShardTable =
  | "nodes"
  | "tagColors"
  | "savedQueries"
  | "dailyIndex"
  | "migrateState"
  | "runs";

/** Minimal mutator ctx — defineMutator's ServerContext is the base MutationCtx. */
type MutatorDb = {
  query: (table: ShardTable) => {
    collect: () => Promise<Array<Record<string, unknown> & { _id: string }>>;
    withIndex: (
      name: string,
      fn: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
    ) => {
      first: () => Promise<(Record<string, unknown> & { _id: string }) | null>;
      collect: () => Promise<Array<Record<string, unknown> & { _id: string }>>;
    };
  };
  get: (
    id: Id<ShardTable>,
    expectedTable?: ShardTable,
  ) => Promise<(Record<string, unknown> & { _id: string }) | null>;
  insert: (
    table: ShardTable,
    document: Record<string, unknown>,
    options?: { clientId?: string },
  ) => Promise<string>;
  /**
   * Always pass `expectedTable`. Unscoped patch/delete resolve the id via
   * `UNION ALL` across every shard table; Workerd SQLite's compound-SELECT
   * limit is low enough that a 5–6 table schema blows up with
   * `too many terms in compound SELECT` (seen on first dailyIndex KV patch
   * during classic→Lunora migrate).
   */
  patch: (
    id: Id<ShardTable>,
    fields: Record<string, unknown>,
    expectedTable?: ShardTable,
  ) => Promise<void>;
  delete: (id: Id<ShardTable>, expectedTable?: ShardTable) => Promise<void>;
};

type MutatorCtx = {
  auth: { userId?: string | null };
  db: MutatorDb;
};

async function loadNodes(ctx: MutatorCtx): Promise<OutlineNode[]> {
  const rows = await ctx.db.query("nodes").collect();
  return rows.map(docToNode);
}

function assertOwner(ctx: MutatorCtx, userId: string): void {
  if (ctx.auth.userId !== userId) {
    throw new Error("unauthorized: shard userId mismatch");
  }
}

/**
 * Lunora `clientId` must be a UUID — daily keys (`container`, `YYYY-MM-DD`) and
 * tag names are not. Look up side-collection rows by their natural key index
 * and let insert assign a server UUID `_id`.
 */
async function getDailyByKey(
  ctx: MutatorCtx,
  key: string,
): Promise<(Record<string, unknown> & { _id: string }) | null> {
  return ctx.db
    .query("dailyIndex")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
}

async function getTagColorByTag(
  ctx: MutatorCtx,
  tag: string,
): Promise<(Record<string, unknown> & { _id: string }) | null> {
  return ctx.db
    .query("tagColors")
    .withIndex("by_tag", (q) => q.eq("tag", tag))
    .first();
}

async function commitPlan(ctx: MutatorCtx, plan: OutlinePlan): Promise<void> {
  // deletes → patches → inserts: restore-safe (a deleted id must be gone
  // before a same-batch insert could reclaim it) and fine for structural ops.
  for (const id of plan.deletes) {
    await ctx.db.delete(id as Id<"nodes">, "nodes");
  }

  for (const patch of plan.patches) {
    await ctx.db.patch(
      patch.id as Id<"nodes">,
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

const userIdArg = v.string();
const idArg = v.string();
const tsArg = v.number();
const kindArg = v.optional(v.literal("paragraph").nullable());

/** Compose smoke mutator — proves codegen + SHARD wiring without dual auth UX. */
export const hello = defineMutator({
  args: { userId: userIdArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    return { ok: true as const, userId: args.userId };
  },
});

export const insertSibling = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    parentId: v.string().nullable(),
    afterId: v.string().nullable(),
    text: v.string(),
    isTask: v.optional(v.boolean()),
    kind: kindArg,
    createdAt: tsArg,
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planInsertSibling(index, {
      id: args.id,
      userId: args.userId,
      parentId: args.parentId,
      afterId: args.afterId,
      text: args.text,
      isTask: args.isTask,
      kind: args.kind,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
    if (!plan) throw new Error("insertSibling: invalid parent/afterId");
    await commitPlan(mctx, plan);
    return { id: args.id };
  },
});

export const insertChildAtStart = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    parentId: v.string().nullable(),
    text: v.string(),
    isTask: v.optional(v.boolean()),
    kind: kindArg,
    createdAt: tsArg,
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planInsertChildAtStart(index, {
      id: args.id,
      userId: args.userId,
      parentId: args.parentId,
      text: args.text,
      isTask: args.isTask,
      kind: args.kind,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
    if (!plan) throw new Error("insertChildAtStart: invalid parent");
    await commitPlan(mctx, plan);
    return { id: args.id };
  },
});

/** Quick-add / append-at-end — server resolves last sibling (one watermark). */
export const appendChild = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    parentId: v.string().nullable(),
    text: v.string(),
    isTask: v.optional(v.boolean()),
    kind: kindArg,
    createdAt: tsArg,
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planAppendChild(index, {
      id: args.id,
      userId: args.userId,
      parentId: args.parentId,
      text: args.text,
      isTask: args.isTask,
      kind: args.kind,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
    if (!plan) throw new Error("appendChild: invalid parent");
    await commitPlan(mctx, plan);
    return { id: args.id };
  },
});

/**
 * Enter mid-split: left text stays on `id`, right text lands in `newId` sibling
 * — one DO transaction / watermark.
 */
export const splitNode = defineMutator({
  args: {
    id: idArg,
    newId: idArg,
    userId: userIdArg,
    parentId: v.string().nullable(),
    afterId: idArg,
    leftText: v.string(),
    rightText: v.string(),
    isTask: v.optional(v.boolean()),
    kind: kindArg,
    createdAt: tsArg,
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planSplitNode(index, {
      id: args.id,
      newId: args.newId,
      userId: args.userId,
      parentId: args.parentId,
      afterId: args.afterId,
      leftText: args.leftText,
      rightText: args.rightText,
      isTask: args.isTask,
      kind: args.kind,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
    if (!plan) throw new Error("splitNode: invalid id/parent/afterId");
    await commitPlan(mctx, plan);
    return { id: args.newId };
  },
});

/**
 * Server-authoritative empty-outline seed. Concurrent calls serialize on the
 * DO watermark FIFO — second sees non-empty and returns `{ seeded: false }`.
 */
export const seedIfEmpty = defineMutator({
  args: {
    userId: userIdArg,
    createdAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const nodes = await loadNodes(mctx);
    const plan = planSeedIfEmpty(nodes, {
      userId: args.userId,
      createdAt: args.createdAt,
    });
    if (!plan) return { seeded: false as const };
    await commitPlan(mctx, plan);
    return {
      seeded: true as const,
      ids: plan.inserts.map((n) => n.id),
    };
  },
});

export const indent = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    updatedAt: tsArg,
    resolveMirror: v.optional(v.boolean()),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planIndent(
      index,
      args.id,
      args.updatedAt,
      args.resolveMirror ?? false,
    );
    if (!plan) throw new Error("indent: no-op or missing node");
    await commitPlan(mctx, plan);
  },
});

export const outdent = defineMutator({
  args: { id: idArg, userId: userIdArg, updatedAt: tsArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planOutdent(index, args.id, args.updatedAt);
    if (!plan) throw new Error("outdent: no-op or missing node");
    await commitPlan(mctx, plan);
  },
});

export const removeNode = defineMutator({
  args: { id: idArg, userId: userIdArg, updatedAt: tsArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planRemoveNode(index, args.id, args.updatedAt);
    if (!plan) throw new Error("removeNode: missing node");
    await commitPlan(mctx, plan);
  },
});

export const moveNode = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    newParentId: v.string().nullable(),
    afterSiblingId: v.string().nullable(),
    updatedAt: tsArg,
    expandIds: v.optional(v.array(v.string())),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planMoveNode(index, {
      id: args.id,
      newParentId: args.newParentId,
      afterSiblingId: args.afterSiblingId,
      updatedAt: args.updatedAt,
      expandIds: args.expandIds,
    });
    if (!plan) throw new Error("moveNode: no-op or invalid");
    await commitPlan(mctx, plan);
  },
});

export const setText = defineMutator({
  args: { id: idArg, userId: userIdArg, text: v.string(), updatedAt: tsArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planSetText(index, args.id, args.text, args.updatedAt);
    if (!plan) throw new Error("setText: missing node");
    await commitPlan(mctx, plan);
  },
});

export const setCompleted = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    completed: v.boolean(),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planSetCompleted(
      index,
      args.id,
      args.completed,
      args.updatedAt,
    );
    if (!plan) throw new Error("setCompleted: missing node");
    await commitPlan(mctx, plan);
  },
});

export const setCollapsed = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    collapsed: v.boolean(),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planSetCollapsed(
      index,
      args.id,
      args.collapsed,
      args.updatedAt,
    );
    if (!plan) throw new Error("setCollapsed: missing node");
    await commitPlan(mctx, plan);
  },
});

export const setIsTask = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    isTask: v.boolean(),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planSetIsTask(index, args.id, args.isTask, args.updatedAt);
    if (!plan) throw new Error("setIsTask: missing node");
    await commitPlan(mctx, plan);
  },
});

export const setKind = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    kind: v.literal("paragraph").nullable(),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planSetKind(index, args.id, args.kind, args.updatedAt);
    if (!plan) throw new Error("setKind: missing node");
    await commitPlan(mctx, plan);
  },
});

export const setBookmarkedAt = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    bookmarkedAt: v.number().nullable(),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planSetBookmarkedAt(
      index,
      args.id,
      args.bookmarkedAt,
      args.updatedAt,
    );
    if (!plan) throw new Error("setBookmarkedAt: missing node");
    await commitPlan(mctx, plan);
  },
});

const nodeSnapshotArg = v.object({
  id: idArg,
  userId: userIdArg,
  parentId: v.string().nullable(),
  prevSiblingId: v.string().nullable(),
  text: v.string(),
  isTask: v.boolean(),
  completed: v.boolean(),
  collapsed: v.boolean(),
  bookmarkedAt: v.number().nullable(),
  mirrorOf: v.string().nullable(),
  createdAt: tsArg,
  updatedAt: tsArg,
  origin: v.string().nullable(),
  kind: v.literal("paragraph").nullable(),
});

/**
 * Classic-style `{ops}` delta batch — one watermark for insert/update/delete
 * without shipping the whole outline (markdown paste, structural batches).
 * `restoreNodes` stays for undo/redo snapshots that already carry a full target.
 */
export const applyChangeOps = defineMutator({
  args: {
    userId: userIdArg,
    ops: v.array(changeOpArg),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    if (args.ops.length === 0) {
      return { count: 0, deletes: 0, inserts: 0, patches: 0 };
    }
    const plan = planFromChangeOps(args.userId, args.ops);
    await commitPlan(mctx, plan);
    return {
      count: args.ops.length,
      deletes: plan.deletes.length,
      inserts: plan.inserts.length,
      patches: plan.patches.length,
    };
  },
});

/**
 * Undo/redo snapshot restore — one DO transaction / watermark for the whole
 * diff (deletes + upserts), even when large. Client sends the target outline
 * subset (full snapshots for touched + surviving ids via planRestoreNodes).
 */
export const restoreNodes = defineMutator({
  args: {
    userId: userIdArg,
    /** Full target outline after restore (history snapshot + userId). */
    nodes: v.array(nodeSnapshotArg),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const current = await loadNodes(mctx);
    // Force shard owner — never trust a client-supplied snapshot userId.
    const target: OutlineNode[] = args.nodes.map((n) => ({
      ...n,
      userId: args.userId,
      kind: n.kind === "paragraph" ? "paragraph" : null,
    }));
    const plan = planRestoreNodes(current, target);
    await commitPlan(mctx, plan);
    return {
      deletes: plan.deletes.length,
      inserts: plan.inserts.length,
      patches: plan.patches.length,
    };
  },
});

/**
 * OPML / classic→Lunora migrate batch. New ids insert; existing ids patch
 * **structure only** (`parentId` / `prevSiblingId`) so a force remigrate can
 * reattach orphaned Daily days from classic without clobbering Lunora-era
 * text / task / bookmark field edits. Large imports may call this multiple
 * times (clientSeq FIFO); a mid-import failure can leave earlier chunks
 * durable — see HANDOFF.
 */
export const importNodes = defineMutator({
  args: {
    userId: userIdArg,
    nodes: v.array(nodeSnapshotArg),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    // Force shard owner — never trust a client-supplied snapshot userId.
    let inserted = 0;
    let patched = 0;
    for (const raw of args.nodes) {
      const node: OutlineNode = {
        ...raw,
        userId: args.userId,
        kind: raw.kind === "paragraph" ? "paragraph" : null,
      };
      const id = node.id as Id<"nodes">;
      const existing = await mctx.db.get(id, "nodes");
      if (existing) {
        if (
          existing.parentId !== node.parentId ||
          existing.prevSiblingId !== node.prevSiblingId
        ) {
          await mctx.db.patch(
            id,
            {
              parentId: node.parentId,
              prevSiblingId: node.prevSiblingId,
            },
            "nodes",
          );
          patched++;
        }
      } else {
        await mctx.db.insert("nodes", nodeToInsertFields(node), {
          clientId: node.id,
        });
        inserted++;
      }
    }
    return { count: args.nodes.length, inserted, patched };
  },
});

const kvImportRowArg = v.union(
  v.object({
    kind: v.literal("tagColor"),
    tag: v.string(),
    color: v.string(),
  }),
  v.object({
    kind: v.literal("savedQuery"),
    id: idArg,
    name: v.string(),
    query: v.string(),
    createdAt: tsArg,
  }),
  v.object({
    kind: v.literal("dailyIndex"),
    key: v.string(),
    nodeId: idArg,
    touchedAt: tsArg,
  }),
);

/** One migration batch across the three shard-local side-collections. */
export const importKvRows = defineMutator({
  args: {
    userId: userIdArg,
    rows: v.array(kvImportRowArg),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    for (const row of args.rows) {
      if (row.kind === "tagColor") {
        const existing = await getTagColorByTag(mctx, row.tag);
        if (existing) {
          await mctx.db.patch(
            existing._id as Id<"tagColors">,
            { color: row.color },
            "tagColors",
          );
        } else {
          await mctx.db.insert("tagColors", {
            tag: row.tag,
            color: row.color,
            userId: args.userId,
          });
        }
      } else if (row.kind === "savedQuery") {
        const id = row.id as Id<"savedQueries">;
        const existing = await mctx.db.get(id, "savedQueries");
        const fields = {
          name: row.name,
          query: row.query,
          createdAt: row.createdAt,
        };
        if (existing) await mctx.db.patch(id, fields, "savedQueries");
        else {
          await mctx.db.insert(
            "savedQueries",
            { ...fields, userId: args.userId },
            { clientId: row.id },
          );
        }
      } else {
        const existing = await getDailyByKey(mctx, row.key);
        const fields = {
          nodeId: row.nodeId,
          touchedAt: row.touchedAt,
        };
        if (existing) {
          await mctx.db.patch(
            existing._id as Id<"dailyIndex">,
            fields,
            "dailyIndex",
          );
        } else {
          await mctx.db.insert("dailyIndex", {
            key: row.key,
            ...fields,
            userId: args.userId,
          });
        }
      }
    }
    return { count: args.rows.length };
  },
});

/** `/mirror` — last-child mirror of source under targetParentId (ADR 0022). */
export const mirrorNode = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    sourceId: idArg,
    targetParentId: v.string().nullable(),
    createdAt: tsArg,
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planMirrorNode(index, args);
    if (!plan) throw new Error("mirrorNode: missing source/target or cycle");
    await commitPlan(mctx, plan);
    return { id: args.id };
  },
});

/** Multi-select delete — one watermark (ADR 0018). */
export const removeMany = defineMutator({
  args: {
    userId: userIdArg,
    nodeIds: v.array(idArg),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const nodes = await loadNodes(mctx);
    const plan = planRemoveMany(nodes, args.nodeIds, args.updatedAt);
    if (!plan) throw new Error("removeMany: no-op");
    await commitPlan(mctx, plan);
  },
});

/** Multi-select move / Send-to-Today — one watermark (ADR 0018). */
export const moveMany = defineMutator({
  args: {
    userId: userIdArg,
    targetId: v.string().nullable(),
    nodeIds: v.array(idArg),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const nodes = await loadNodes(mctx);
    const plan = planMoveMany(nodes, {
      targetId: args.targetId,
      nodeIds: args.nodeIds,
      updatedAt: args.updatedAt,
    });
    if (!plan) throw new Error("moveMany: no-op");
    await commitPlan(mctx, plan);
  },
});

/** Multi-select Tab indent — one watermark (ADR 0018). */
export const indentMany = defineMutator({
  args: {
    userId: userIdArg,
    nodeIds: v.array(idArg),
    updatedAt: tsArg,
    resolveMirror: v.optional(v.boolean()),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const nodes = await loadNodes(mctx);
    const plan = planIndentMany(
      nodes,
      args.nodeIds,
      args.updatedAt,
      args.resolveMirror ?? false,
    );
    if (!plan) throw new Error("indentMany: no-op");
    await commitPlan(mctx, plan);
  },
});

/** Multi-select Shift+Tab outdent — one watermark (ADR 0018). */
export const outdentMany = defineMutator({
  args: {
    userId: userIdArg,
    nodeIds: v.array(idArg),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const nodes = await loadNodes(mctx);
    const plan = planOutdentMany(nodes, args.nodeIds, args.updatedAt);
    if (!plan) throw new Error("outdentMany: no-op");
    await commitPlan(mctx, plan);
  },
});

/**
 * Daily get-or-create node half — scaffold + day (+ optional seed) after the
 * client has claimed ids via `claimDailyMapping` (flag ON) or `/api/kv`
 * (flag OFF). ADR 0041 `seedEntryLine` is an optional empty child in `inserts`.
 */
export const materializeDailyNodes = defineMutator({
  args: {
    userId: userIdArg,
    inserts: v.array(
      v.object({
        id: idArg,
        parentId: v.string().nullable(),
        afterId: v.string().nullable(),
        text: v.string(),
      }),
    ),
    createdAt: tsArg,
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const nodes = await loadNodes(mctx);
    const plan = planMaterializeDailyNodes(nodes, {
      userId: args.userId,
      inserts: args.inserts,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
    if (!plan) throw new Error("materializeDailyNodes: no-op or invalid");
    await commitPlan(mctx, plan);
    return { count: args.inserts.length };
  },
});

// --- Phase 2b side-collections (tagColors + savedQueries) -------------------

/** Upsert a tag color. Natural key = `tag` (index `by_tag`); `_id` is a UUID. */
export const upsertTagColor = defineMutator({
  args: {
    userId: userIdArg,
    tag: v.string(),
    color: v.string(),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await getTagColorByTag(mctx, args.tag);
    if (existing) {
      await mctx.db.patch(
        existing._id as Id<"tagColors">,
        { color: args.color },
        "tagColors",
      );
    } else {
      // No clientId: tag names aren't UUIDs (Lunora requires UUID clientIds).
      await mctx.db.insert("tagColors", {
        tag: args.tag,
        color: args.color,
        userId: args.userId,
      });
    }
  },
});

export const deleteTagColor = defineMutator({
  args: { userId: userIdArg, tag: v.string() },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await getTagColorByTag(mctx, args.tag);
    if (existing)
      await mctx.db.delete(existing._id as Id<"tagColors">, "tagColors");
  },
});

/** Insert a saved query row (`id` = clientId). */
export const upsertSavedQuery = defineMutator({
  args: {
    userId: userIdArg,
    id: idArg,
    name: v.string(),
    query: v.string(),
    createdAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await mctx.db.get(
      args.id as Id<"savedQueries">,
      "savedQueries",
    );
    if (existing) {
      await mctx.db.patch(
        args.id as Id<"savedQueries">,
        {
          name: args.name,
          query: args.query,
          createdAt: args.createdAt,
        },
        "savedQueries",
      );
    } else {
      await mctx.db.insert(
        "savedQueries",
        {
          name: args.name,
          query: args.query,
          createdAt: args.createdAt,
          userId: args.userId,
        },
        { clientId: args.id },
      );
    }
  },
});

export const patchSavedQuery = defineMutator({
  args: {
    userId: userIdArg,
    id: idArg,
    name: v.optional(v.string()),
    query: v.optional(v.string()),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await mctx.db.get(
      args.id as Id<"savedQueries">,
      "savedQueries",
    );
    if (!existing) return;
    const fields: Record<string, unknown> = {};
    if (args.name !== undefined) fields.name = args.name;
    if (args.query !== undefined) fields.query = args.query;
    if (Object.keys(fields).length === 0) return;
    await mctx.db.patch(args.id as Id<"savedQueries">, fields, "savedQueries");
  },
});

export const deleteSavedQuery = defineMutator({
  args: { userId: userIdArg, id: idArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await mctx.db.get(
      args.id as Id<"savedQueries">,
      "savedQueries",
    );
    if (existing)
      await mctx.db.delete(args.id as Id<"savedQueries">, "savedQueries");
  },
});

// --- dailyIndex (atomic claim = DO getOrCreateKv twin) ----------------------

/**
 * Atomic get-or-create of a `key → nodeId` mapping. Pre-existing wins; returns
 * `{ nodeId, won }` so the client knows whether to materialize the node.
 * Natural key = `key` (index `by_key`); `_id` is a server UUID (keys like
 * `container` / `YYYY-MM-DD` are not valid Lunora clientIds).
 */
export const claimDailyMapping = defineMutator({
  args: {
    userId: userIdArg,
    key: v.string(),
    nodeId: idArg,
    touchedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await getDailyByKey(mctx, args.key);
    const existingNodeId =
      existing && typeof existing.nodeId === "string" ? existing.nodeId : null;
    const { winner, won } = resolveDailyClaim(existingNodeId, args.nodeId);
    if (existing) {
      // Always write (touchedAt) so the watermark poke fires even on a lost race.
      await mctx.db.patch(
        existing._id as Id<"dailyIndex">,
        {
          nodeId: winner,
          touchedAt: args.touchedAt,
        },
        "dailyIndex",
      );
    } else {
      await mctx.db.insert("dailyIndex", {
        key: args.key,
        nodeId: winner,
        touchedAt: args.touchedAt,
        userId: args.userId,
      });
    }
    return { nodeId: winner, won };
  },
});

/** Upsert a daily-index mapping (heal / setMapping). */
export const upsertDailyMapping = defineMutator({
  args: {
    userId: userIdArg,
    key: v.string(),
    nodeId: idArg,
    touchedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await getDailyByKey(mctx, args.key);
    if (existing) {
      await mctx.db.patch(
        existing._id as Id<"dailyIndex">,
        {
          nodeId: args.nodeId,
          touchedAt: args.touchedAt,
        },
        "dailyIndex",
      );
    } else {
      await mctx.db.insert("dailyIndex", {
        key: args.key,
        nodeId: args.nodeId,
        touchedAt: args.touchedAt,
        userId: args.userId,
      });
    }
  },
});

export const deleteDailyMapping = defineMutator({
  args: { userId: userIdArg, key: v.string() },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await getDailyByKey(mctx, args.key);
    if (existing)
      await mctx.db.delete(existing._id as Id<"dailyIndex">, "dailyIndex");
  },
});

// --- migrateState (classic → Lunora watermarks) -----------------------------

async function getMigrateStateRow(
  ctx: MutatorCtx,
): Promise<(Record<string, unknown> & { _id: string }) | null> {
  const rows = await ctx.db.query("migrateState").collect();
  return rows[0] ?? null;
}

/** Read migrate watermarks (`null` fields = incomplete). */
export const getMigrateState = defineMutator({
  args: { userId: userIdArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const row = await getMigrateStateRow(mctx);
    if (!row)
      return { nodesAt: null as number | null, kvAt: null as number | null };
    return {
      nodesAt: typeof row.nodesAt === "number" ? row.nodesAt : null,
      kvAt: typeof row.kvAt === "number" ? row.kvAt : null,
    };
  },
});

/**
 * Upsert migrate watermarks. Omitted fields are left unchanged (or null on
 * first insert). Pass an explicit timestamp to mark that half complete.
 */
export const setMigrateState = defineMutator({
  args: {
    userId: userIdArg,
    nodesAt: v.optional(v.number().nullable()),
    kvAt: v.optional(v.number().nullable()),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await getMigrateStateRow(mctx);
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (args.nodesAt !== undefined) patch.nodesAt = args.nodesAt;
      if (args.kvAt !== undefined) patch.kvAt = args.kvAt;
      if (Object.keys(patch).length > 0) {
        await mctx.db.patch(
          existing._id as Id<"migrateState">,
          patch,
          "migrateState",
        );
      }
      const next = await getMigrateStateRow(mctx);
      return {
        nodesAt: typeof next?.nodesAt === "number" ? next.nodesAt : null,
        kvAt: typeof next?.kvAt === "number" ? next.kvAt : null,
      };
    }
    const nodesAt = args.nodesAt === undefined ? null : args.nodesAt;
    const kvAt = args.kvAt === undefined ? null : args.kvAt;
    await mctx.db.insert("migrateState", {
      userId: args.userId,
      nodesAt,
      kvAt,
    });
    return { nodesAt, kvAt };
  },
});

// --- runs (inline @agent, ADR 0059) -----------------------------------------

const MAX_CONCURRENT_RUNS = 3;

async function getRunByQuestion(
  ctx: MutatorCtx,
  questionNodeId: string,
): Promise<(Record<string, unknown> & { _id: string }) | null> {
  const rows = await ctx.db
    .query("runs")
    .withIndex("by_question", (q) => q.eq("questionNodeId", questionNodeId))
    .collect();
  // Prefer the newest running row; else the newest row overall.
  let best: (Record<string, unknown> & { _id: string }) | null = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    const bestTs = typeof best.updatedAt === "number" ? best.updatedAt : 0;
    const rowTs = typeof row.updatedAt === "number" ? row.updatedAt : 0;
    if (row.status === "running" && best.status !== "running") best = row;
    else if (row.status === best.status && rowTs > bestTs) best = row;
  }
  return best;
}

/** Create or reuse a running row for a question node. Enforces concurrency. */
export const createAgentRun = defineMutator({
  args: {
    userId: userIdArg,
    questionNodeId: idArg,
    createdAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);

    const existing = await getRunByQuestion(mctx, args.questionNodeId);
    if (existing && existing.status === "running") {
      return {
        runId: existing._id,
        reused: true,
        answerRootId:
          typeof existing.answerRootId === "string"
            ? existing.answerRootId
            : null,
        answerHash:
          typeof existing.answerHash === "string" ? existing.answerHash : null,
      };
    }

    const all = await mctx.db.query("runs").collect();
    const running = all.filter((r) => r.status === "running").length;
    if (running >= MAX_CONCURRENT_RUNS) {
      throw new Error("too many concurrent agent runs");
    }

    const runId = await mctx.db.insert("runs", {
      userId: args.userId,
      questionNodeId: args.questionNodeId,
      status: "running",
      partialText: "",
      answerRootId:
        typeof existing?.answerRootId === "string"
          ? existing.answerRootId
          : null,
      answerHash:
        typeof existing?.answerHash === "string" ? existing.answerHash : null,
      error: null,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    });
    return {
      runId,
      reused: false,
      answerRootId:
        typeof existing?.answerRootId === "string"
          ? existing.answerRootId
          : null,
      answerHash:
        typeof existing?.answerHash === "string" ? existing.answerHash : null,
    };
  },
});

export const cancelAgentRun = defineMutator({
  args: { userId: userIdArg, runId: idArg, updatedAt: tsArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const row = await mctx.db.get(args.runId as Id<"runs">, "runs");
    if (!row || row.userId !== args.userId) return { ok: false as const };
    if (row.status !== "running") return { ok: false as const };
    await mctx.db.patch(
      args.runId as Id<"runs">,
      {
        status: "cancelled",
        partialText: "",
        updatedAt: args.updatedAt,
      },
      "runs",
    );
    return { ok: true as const };
  },
});

export const patchAgentRunPartial = defineMutator({
  args: {
    userId: userIdArg,
    runId: idArg,
    partialText: v.string(),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const row = await mctx.db.get(args.runId as Id<"runs">, "runs");
    if (!row || row.userId !== args.userId || row.status !== "running") return;
    await mctx.db.patch(
      args.runId as Id<"runs">,
      { partialText: args.partialText, updatedAt: args.updatedAt },
      "runs",
    );
  },
});

export const completeAgentRun = defineMutator({
  args: {
    userId: userIdArg,
    runId: idArg,
    answerRootId: idArg,
    answerHash: v.string(),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const row = await mctx.db.get(args.runId as Id<"runs">, "runs");
    if (!row || row.userId !== args.userId) return;
    await mctx.db.patch(
      args.runId as Id<"runs">,
      {
        status: "completed",
        partialText: "",
        answerRootId: args.answerRootId,
        answerHash: args.answerHash,
        error: null,
        updatedAt: args.updatedAt,
      },
      "runs",
    );
  },
});

export const failAgentRun = defineMutator({
  args: {
    userId: userIdArg,
    runId: idArg,
    error: v.string(),
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const row = await mctx.db.get(args.runId as Id<"runs">, "runs");
    if (!row || row.userId !== args.userId) return;
    await mctx.db.patch(
      args.runId as Id<"runs">,
      {
        status: "error",
        partialText: "",
        error: args.error,
        updatedAt: args.updatedAt,
      },
      "runs",
    );
  },
});

/** Read a run (cooperative cancel checks + client polling fallback). */
export const getAgentRun = defineMutator({
  args: { userId: userIdArg, runId: idArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const row = await mctx.db.get(args.runId as Id<"runs">, "runs");
    if (!row || row.userId !== args.userId) return null;
    return {
      status: row.status as "running" | "completed" | "cancelled" | "error",
      questionNodeId: String(row.questionNodeId ?? ""),
      partialText: String(row.partialText ?? ""),
      answerRootId:
        typeof row.answerRootId === "string" ? row.answerRootId : null,
      answerHash: typeof row.answerHash === "string" ? row.answerHash : null,
      error: typeof row.error === "string" ? row.error : null,
    };
  },
});

/**
 * Commit a canned/real answer tree in ONE transaction: optional replace of an
 * untouched prior answer, append summary + collapsed detail, stamp origin,
 * complete the run with the replace-guard hash (ADR 0059).
 */
export const commitAgentAnswer = defineMutator({
  args: {
    userId: userIdArg,
    runId: idArg,
    questionNodeId: idArg,
    summaryText: v.string(),
    detailText: v.string(),
    priorAnswerRootId: v.string().nullable(),
    priorAnswerHash: v.string().nullable(),
    summaryId: idArg,
    detailId: idArg,
    updatedAt: tsArg,
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);

    // Plan entirely in memory, then ONE commitPlan + run patch. The mutator
    // handler is already one DO transaction; a single plan keeps node writes
    // contiguous (ADR 0059 "one mutator transaction").
    let nodes = await loadNodes(mctx);
    let index = buildTreeIndex(nodes);
    if (!index.byId.has(args.questionNodeId)) {
      return { ok: false as const, error: "question node missing" };
    }

    const combined = emptyPlan();
    const absorb = (step: OutlinePlan) => {
      combined.deletes.push(...step.deletes);
      combined.patches.push(...step.patches);
      combined.inserts.push(...step.inserts);
      nodes = applyPlan(nodes, step);
      index = buildTreeIndex(nodes);
    };

    if (
      args.priorAnswerRootId &&
      args.priorAnswerHash &&
      shouldReplaceAnswer(index, args.priorAnswerRootId, args.priorAnswerHash)
    ) {
      const remove = planRemoveNode(
        index,
        args.priorAnswerRootId,
        args.updatedAt,
      );
      if (remove) absorb(remove);
    }

    const appendSummary = planAppendChild(index, {
      id: args.summaryId,
      userId: args.userId,
      parentId: args.questionNodeId,
      text: args.summaryText,
      createdAt: args.updatedAt,
      updatedAt: args.updatedAt,
    });
    if (!appendSummary) {
      return { ok: false as const, error: "could not append answer" };
    }
    absorb({
      deletes: appendSummary.deletes,
      patches: appendSummary.patches,
      inserts: appendSummary.inserts.map((n) => ({ ...n, origin: "agent" })),
    });

    // Skip empty detail so a one-line answer is summary-only (ADR 0059).
    if (args.detailText.trim()) {
      const appendDetail = planAppendChild(index, {
        id: args.detailId,
        userId: args.userId,
        parentId: args.summaryId,
        text: args.detailText,
        createdAt: args.updatedAt,
        updatedAt: args.updatedAt,
      });
      if (appendDetail) {
        absorb({
          deletes: appendDetail.deletes,
          patches: appendDetail.patches,
          inserts: appendDetail.inserts.map((n) => ({
            ...n,
            origin: "agent",
            collapsed: true,
          })),
        });
      }
    }

    await commitPlan(mctx, combined);

    const answerHash = hashAnswerSubtree(index, args.summaryId) ?? "";
    await mctx.db.patch(
      args.runId as Id<"runs">,
      {
        status: "completed",
        partialText: "",
        answerRootId: args.summaryId,
        answerHash,
        error: null,
        updatedAt: args.updatedAt,
      },
      "runs",
    );
    return { ok: true as const, answerRootId: args.summaryId };
  },
});
