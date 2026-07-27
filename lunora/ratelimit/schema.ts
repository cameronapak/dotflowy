import type { RateLimitConfigMap } from "lunorash/ratelimit";
import type { Middleware } from "lunorash/server";

import { createDbStore, RateLimiter } from "lunorash/ratelimit";
import {
  defineSchemaExtension,
  defineTable,
  definePlugin,
  v,
} from "lunorash/server";

import { scopeRateLimitDb, type DbWithAsId } from "./scope-db";

export const limits = {
  default: { kind: "token bucket", period: 60_000, rate: 10 },
  /** Inline `@agent` fire (ADR 0059) — paid beta; keep cheap while stubbed. */
  agent: { kind: "token bucket", period: 60_000, rate: 20, capacity: 20 },
} as const satisfies RateLimitConfigMap;

export type LimitName = keyof typeof limits;

const RATE_LIMIT_TABLE = "ratelimit_buckets";

/** Durable DO-backed limiter; scopes patch/delete via `asId` (see scope-db). */
export const makeRateLimiter = (ctx: { db: unknown }): RateLimiter<LimitName> =>
  new RateLimiter<LimitName>({
    config: limits,
    store: createDbStore({
      db: scopeRateLimitDb(ctx.db as DbWithAsId, RATE_LIMIT_TABLE),
      table: RATE_LIMIT_TABLE,
    }),
  });

const middleware: Middleware<
  { api?: Record<string, unknown>; db: unknown },
  { api: Record<string, unknown>; db: unknown }
> = ({ ctx, next }) =>
  next({
    ctx: {
      ...ctx,
      api: { ...ctx.api, ratelimit: makeRateLimiter(ctx) },
    },
  });

export const ratelimit = definePlugin("ratelimit", {
  extension: defineSchemaExtension("ratelimit", {
    tables: {
      buckets: defineTable({
        key: v.string(),
        value: v.number(),
        ts: v.number(),
        prev: v.optional(v.number()),
      })
        .index("by_key", ["key"])
        .externallyManaged(),
    },
  }),
  middleware,
});
