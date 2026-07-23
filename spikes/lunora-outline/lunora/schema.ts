import { defineSchema, defineTable, v } from "lunorash/server";

import { ratelimit } from "./ratelimit/schema.js";

export default defineSchema({
  messages: defineTable({
    channelId: v.string(),
    text: v.string(),
  })
    .shardBy("channelId")
    .index("by_channel", ["channelId"]),
}).extend(ratelimit.extension);
