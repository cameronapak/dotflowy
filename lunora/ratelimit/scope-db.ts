import type { RateLimitDb } from "lunorash/ratelimit";

/**
 * `createDbStore` calls `db.patch(id, …)` / `db.delete(id)` with a bare id.
 * On this shard an unscoped id lookup is `UNION ALL` across every table —
 * Workerd SQLite then hits `too many terms in compound SELECT`. Branding
 * via `asId(table, id)` scopes the write (same fix as `lunora/mcp.ts`).
 */
export type DbWithAsId = RateLimitDb & {
  asId: (table: string, id: string) => unknown;
};

export function scopeRateLimitDb(db: DbWithAsId, table: string): RateLimitDb {
  return {
    query: (t) => db.query(t),
    insert: (t, doc) => db.insert(t, doc),
    patch: (id, patch) =>
      db.patch(db.asId(table, String(id)) as typeof id, patch),
    delete: (id) => db.delete(db.asId(table, String(id)) as typeof id),
  };
}
