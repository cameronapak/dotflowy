import type { RateLimitDb } from "lunorash/ratelimit";

/**
 * `createDbStore` calls `db.patch(id, …)` / `db.delete(id)` with a bare id.
 * Unscoped id lookup is `UNION ALL` across every shard table — Workerd SQLite
 * then hits `too many terms in compound SELECT`. Pass `expectedTable` as the
 * third arg (same load-bearing rule as `lunora/mutators.ts`).
 *
 * Note: `asId(table, id)` is a TypeScript brand only — at runtime it returns
 * the same string and does NOT scope the write.
 */
export type DbWithScopedWrites = RateLimitDb & {
  patch: (
    id: Parameters<RateLimitDb["patch"]>[0],
    patch: Parameters<RateLimitDb["patch"]>[1],
    expectedTable?: string,
  ) => Promise<void>;
  delete: (
    id: Parameters<RateLimitDb["delete"]>[0],
    expectedTable?: string,
  ) => Promise<void>;
};

export function scopeRateLimitDb(
  db: DbWithScopedWrites,
  table: string,
): RateLimitDb {
  return {
    query: (t) => db.query(t),
    insert: (t, doc) => db.insert(t, doc),
    patch: (id, patch) => db.patch(id, patch, table),
    delete: (id) => db.delete(id, table),
  };
}
