-- Generic per-owner key/value store backing the plugin side-collections
-- (tag colors, the daily index -- ADR 0018 Seam E). Both are pure key->value
-- maps, so rather than a bespoke table each they share one `kv` table keyed by
-- (owner, collection, key); `value` is the JSON-stringified item. `owner`
-- scopes every row to the authenticated user, same as `nodes`. See ADR 0024.
CREATE TABLE IF NOT EXISTS kv (
  owner      TEXT NOT NULL,
  collection TEXT NOT NULL,   -- 'tag-colors' | 'daily-index'
  key        TEXT NOT NULL,   -- the collection's getKey value
  value      TEXT NOT NULL,   -- JSON-stringified item
  updatedAt  INTEGER NOT NULL,
  PRIMARY KEY (owner, collection, key)
);

-- Every read fetches one owner's one collection in full.
CREATE INDEX IF NOT EXISTS idx_kv_owner_collection ON kv(owner, collection);
