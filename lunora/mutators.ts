import { defineMutator, v } from "lunorash/server";

import type { Id } from "./_generated/dataModel";

import {
  buildTreeIndex,
  docToNode,
  nodeToInsertFields,
  planIndent,
  planInsertSibling,
  planOutdent,
  planRemoveNode,
  planSeedIfEmpty,
  planSetText,
  type OutlineNode,
  type OutlinePlan,
} from "../src/data/outline-plans";

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
    await ctx.db.insert("nodes", nodeToInsertFields(node), {
      clientId: node.id,
    });
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
