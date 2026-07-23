import { defineSchema, defineTable, v } from "lunorash/server";

import { ratelimit } from "./ratelimit/schema";

/**
 * Outline nodes + kv side-collections — Dotflowy field parity + Lunora
 * `userId` shard key. Dotflowy `id` / kv keys map to Lunora `_id` via
 * `clientId` on insert.
 *
 * Phase 2b: `tagColors` + `savedQueries` + `dailyIndex` ride Lunora when the
 * sync flag is ON. `claimDailyMapping` is the DO `getOrCreateKv` twin.
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

  /** Custom tag colors (ADR 0007). `_id` = normalized tag via clientId. */
  tagColors: defineTable({
    tag: v.string(),
    color: v.string(),
    userId: v.string(),
  })
    .shardBy("userId")
    .index("by_tag", ["tag"]),

  /** Saved filter queries (ADR 0048). `_id` = row id via clientId. */
  savedQueries: defineTable({
    name: v.string(),
    query: v.string(),
    createdAt: v.number(),
    userId: v.string(),
  }).shardBy("userId"),

  /**
   * Daily scaffold identity (ADR 0052). `_id` = key via clientId
   * (`container` / `YYYY` / `YYYY-MM` / `YYYY-Www` / `YYYY-MM-DD`).
   * `touchedAt` bumps on every claim so a lost-race claim still emits a
   * poke (watermark hold needs a write).
   */
  dailyIndex: defineTable({
    key: v.string(),
    nodeId: v.string(),
    touchedAt: v.number(),
    userId: v.string(),
  })
    .shardBy("userId")
    .index("by_key", ["key"]),
}).extend(ratelimit.extension);
