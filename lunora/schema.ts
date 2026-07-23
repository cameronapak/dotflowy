import { defineSchema, defineTable, v } from "lunorash/server";

import { ratelimit } from "./ratelimit/schema";

/**
 * Outline nodes — Dotflowy Node field parity + Lunora `userId` shard key.
 * Dotflowy `id` maps to Lunora `_id` via `clientId` on insert.
 *
 * Phase-2 compose stub: lives beside UserOutlineDO until collection cutover.
 */
export default defineSchema({
  nodes: defineTable({
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
    userId: v.string(),
  })
    .shardBy("userId")
    .index("by_parent", ["parentId"]),
}).extend(ratelimit.extension);
