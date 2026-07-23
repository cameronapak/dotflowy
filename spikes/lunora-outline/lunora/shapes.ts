import { defineShape, v } from "lunorash/server";

/**
 * Whole-outline replication for one user shard.
 * Read-as-permission: only the authenticated owner may subscribe, and the
 * row filter is pinned to their `userId` (never a forged arg alone).
 */
export const wholeOutline = defineShape({
  args: { userId: v.string() },
  table: "nodes",
  where: (ctx, { userId }) => {
    // Shape `where` returns WhereInput (not boolean). `{ OR: [] }` is the
    // vacuously-false deny sentinel used by Lunora RLS/shapes.
    if (!ctx.auth.userId || ctx.auth.userId !== userId) return { OR: [] };
    return { userId };
  },
});
