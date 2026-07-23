import { defineMutator, v } from "lunorash/server";

import type { Id } from "./_generated/dataModel.js";

import {
  buildTreeIndex,
  planIndent,
  planInsertSibling,
  planOutdent,
  planRemoveNode,
  planSetText,
  type OutlineNode,
  type OutlinePlan,
} from "../src/outline/index.js";

/** Minimal mutator ctx — defineMutator's ServerContext is the base MutationCtx. */
type MutatorDb = {
  query: (table: "nodes") => {
    collect: () => Promise<Array<Record<string, unknown> & { _id: string }>>;
  };
  insert: (
    table: "nodes",
    document: Record<string, unknown>,
    options?: { clientId?: string },
  ) => Promise<string>;
  patch: (id: Id<"nodes">, fields: Record<string, unknown>) => Promise<void>;
  delete: (id: Id<"nodes">) => Promise<void>;
};

type MutatorCtx = {
  auth: { userId?: string | null };
  db: MutatorDb;
};

/** Doc → planner node. Codegen currently erases `.nullable()` in Doc types. */
function docToNode(
  doc: Record<string, unknown> & { _id: string },
): OutlineNode {
  return {
    id: doc._id,
    parentId: (doc.parentId as string | null) ?? null,
    prevSiblingId: (doc.prevSiblingId as string | null) ?? null,
    text: String(doc.text ?? ""),
    isTask: Boolean(doc.isTask),
    completed: Boolean(doc.completed),
    collapsed: Boolean(doc.collapsed),
    bookmarkedAt: (doc.bookmarkedAt as number | null) ?? null,
    mirrorOf: (doc.mirrorOf as string | null) ?? null,
    createdAt: Number(doc.createdAt ?? 0),
    updatedAt: Number(doc.updatedAt ?? 0),
    origin: (doc.origin as string | null) ?? null,
    kind: doc.kind === "paragraph" ? "paragraph" : null,
    userId: String(doc.userId ?? ""),
  };
}

async function loadNodes(ctx: MutatorCtx): Promise<OutlineNode[]> {
  const rows = await ctx.db.query("nodes").collect();
  return rows.map(docToNode);
}

function assertOwner(ctx: MutatorCtx, userId: string): void {
  if (ctx.auth.userId !== userId) {
    throw new Error("unauthorized: shard userId mismatch");
  }
}

async function commitPlan(ctx: MutatorCtx, plan: OutlinePlan): Promise<void> {
  for (const node of plan.inserts) {
    const { id, ...fields } = node;
    await ctx.db.insert(
      "nodes",
      {
        parentId: fields.parentId,
        prevSiblingId: fields.prevSiblingId,
        text: fields.text,
        isTask: fields.isTask,
        completed: fields.completed,
        collapsed: fields.collapsed,
        bookmarkedAt: fields.bookmarkedAt,
        mirrorOf: fields.mirrorOf,
        createdAt: fields.createdAt,
        updatedAt: fields.updatedAt,
        origin: fields.origin,
        kind: fields.kind,
        userId: fields.userId,
      },
      { clientId: id },
    );
  }

  for (const patch of plan.patches) {
    await ctx.db.patch(
      patch.id as Id<"nodes">,
      patch.fields as Record<string, unknown>,
    );
  }

  for (const id of plan.deletes) {
    await ctx.db.delete(id as Id<"nodes">);
  }
}

const userIdArg = v.string();
const idArg = v.string();
const tsArg = v.number();

export const insertSibling = defineMutator({
  args: {
    id: idArg,
    userId: userIdArg,
    parentId: v.string().nullable(),
    afterId: v.string().nullable(),
    text: v.string(),
    isTask: v.optional(v.boolean()),
    kind: v.optional(v.literal("paragraph").nullable()),
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

export const indent = defineMutator({
  args: { id: idArg, userId: userIdArg, updatedAt: tsArg },
  server: async (ctx, args) => {
    const mctx = ctx as unknown as MutatorCtx;
    assertOwner(mctx, args.userId);
    const index = buildTreeIndex(await loadNodes(mctx));
    const plan = planIndent(index, args.id, args.updatedAt);
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
