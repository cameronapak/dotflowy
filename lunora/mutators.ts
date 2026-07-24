import { defineMutator, v } from "lunorash/server";

import type { Id } from "./_generated/dataModel";

import {
  buildTreeIndex,
  docToNode,
  nodeToInsertFields,
  planAppendChild,
  planImportNodes,
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

type ShardTable = "nodes" | "tagColors" | "savedQueries" | "dailyIndex";

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
    const target: OutlineNode[] = args.nodes.map((n) => ({
      ...n,
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
 * OPML / bulk insert-only batch. Chains pre-wired by the pure planner.
 * Large imports may call this multiple times (clientSeq FIFO); a mid-import
 * failure can leave earlier chunks durable — see HANDOFF.
 */
export const importNodes = defineMutator({
  args: {
    userId: userIdArg,
    nodes: v.array(nodeSnapshotArg),
  },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const nodes: OutlineNode[] = args.nodes.map((n) => ({
      ...n,
      kind: n.kind === "paragraph" ? "paragraph" : null,
    }));
    const plan = planImportNodes(nodes);
    await commitPlan(mctx, plan);
    return { count: nodes.length };
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
      await mctx.db.patch(existing._id as Id<"tagColors">, {
        color: args.color,
      });
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
    if (existing) await mctx.db.delete(existing._id as Id<"tagColors">);
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
    const existing = await mctx.db.get(args.id as Id<"savedQueries">);
    if (existing) {
      await mctx.db.patch(args.id as Id<"savedQueries">, {
        name: args.name,
        query: args.query,
        createdAt: args.createdAt,
      });
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
    const existing = await mctx.db.get(args.id as Id<"savedQueries">);
    if (!existing) return;
    const fields: Record<string, unknown> = {};
    if (args.name !== undefined) fields.name = args.name;
    if (args.query !== undefined) fields.query = args.query;
    if (Object.keys(fields).length === 0) return;
    await mctx.db.patch(args.id as Id<"savedQueries">, fields);
  },
});

export const deleteSavedQuery = defineMutator({
  args: { userId: userIdArg, id: idArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const existing = await mctx.db.get(args.id as Id<"savedQueries">);
    if (existing) await mctx.db.delete(args.id as Id<"savedQueries">);
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
      await mctx.db.patch(existing._id as Id<"dailyIndex">, {
        nodeId: winner,
        touchedAt: args.touchedAt,
      });
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
      await mctx.db.patch(existing._id as Id<"dailyIndex">, {
        nodeId: args.nodeId,
        touchedAt: args.touchedAt,
      });
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
    if (existing) await mctx.db.delete(existing._id as Id<"dailyIndex">);
  },
});
