import { defineShape, v } from "lunorash/server";

/**
 * Whole-outline replication for one user shard.
 * Read-as-permission: only the authenticated owner may subscribe.
 */

/** Owner-only shape filter — deny sentinel when auth ≠ arg userId. */
function ownerWhere(
  ctx: { auth: { userId?: string | null } },
  userId: string,
): { OR: [] } | { userId: string } {
  // Shape `where` returns WhereInput (not boolean). `{ OR: [] }` is the
  // vacuously-false deny sentinel used by Lunora RLS/shapes.
  if (!ctx.auth.userId || ctx.auth.userId !== userId) return { OR: [] };
  return { userId };
}

export const wholeOutline = defineShape({
  args: { userId: v.string() },
  table: "nodes",
  where: (ctx, { userId }) => ownerWhere(ctx, userId),
});

/** Per-user tag color rows (phase 2b). */
export const userTagColors = defineShape({
  args: { userId: v.string() },
  table: "tagColors",
  where: (ctx, { userId }) => ownerWhere(ctx, userId),
});

/** Per-user saved filter queries (phase 2b). */
export const userSavedQueries = defineShape({
  args: { userId: v.string() },
  table: "savedQueries",
  where: (ctx, { userId }) => ownerWhere(ctx, userId),
});

/** Per-user daily scaffold index (phase 2b — claimDailyMapping). */
export const userDailyIndex = defineShape({
  args: { userId: v.string() },
  table: "dailyIndex",
  where: (ctx, { userId }) => ownerWhere(ctx, userId),
});
