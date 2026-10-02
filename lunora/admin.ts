import { internalQuery, v } from "./_generated/server";

/** Worker-admin-only metadata. Never materialize node documents to count them. */
export const outlineMetadata = internalQuery
  .input({ userId: v.string() })
  .query(async ({ ctx, args }) => {
    const nodeCount = await ctx.db.nodes.count({ userId: args.userId });
    // migrateState contains only userId and completion dates. The pinned
    // projection type produces a union instead of both selected fields.
    const migration = await ctx.db.migrateState.findFirst({
      where: { userId: args.userId },
    });
    return {
      nodeCount,
      nodesMigratedAt: migration?.nodesAt ?? null,
      kvMigratedAt: migration?.kvAt ?? null,
    };
  });
