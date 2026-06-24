# ADR 0024: Plugin side-collections sync via a generic `kv` table

Status: accepted (2026-06-23), implemented (data path verified end-to-end
locally). Extends [ADR 0023](./0023-d1-sync-via-worker.md) (D1 sync via a Worker)
to the plugin **side-collections**, and realizes the "side data should sync"
note ADR 0023 left as a follow-up.

## Glossary

- **Side-collection** — plugin-owned data that never touches the `Node` schema
  (ADR 0018 Seam E). Today: **tag colors** (`src/data/tag-colors.ts`, key = tag
  name → `{ tag, color }`) and the **daily index** (`src/plugins/daily/daily-index.ts`,
  key = `YYYY-MM-DD` or `container` → `{ key, nodeId }`).
- **`kv` table** — one D1 table `(owner, collection, key, value, updatedAt)`
  with PK `(owner, collection, key)`; `value` is the JSON-stringified item.

## Context

After ADR 0023 the nodes synced via D1 but the two side-collections were still
`localStorageCollectionOptions` — so on a second device a user's custom tag
colors and daily-note identities didn't follow. Both are **pure key→value
maps**: a small, fixed item shape, fetched whole, mutated one key at a time.
They don't need their own typed tables or per-field SQL the way `nodes` does.

## Decision

1. **One generic `kv` table backs both**, namespaced by a `collection` column
   (`migrations/0002_create_kv.sql`). A bespoke table per side-collection would
   be ~2× the Worker code and a migration each, for two tables that are
   structurally identical key→value stores. New side-collections ride free.

2. **One `/api/kv` endpoint** (`worker/index.ts`, `handleKv`), parametrized by
   `?collection=`. GET returns the complete set for `(owner, collection)`; POST
   upserts `{ rows: [{ key, value }] }` via `ON CONFLICT(owner, collection, key)
   DO UPDATE`; DELETE drops `{ keys }`. A `KV_COLLECTIONS` allowlist rejects
   unknown namespaces (400). Owner scoping + the localhost dev-owner fallback are
   identical to `/api/nodes` (ADR 0023).

3. **Client = query collections over `/api/kv`.** `kv-api.ts` is the REST client;
   `tag-colors.ts` and `daily-index.ts` each build a `queryCollectionOptions`
   collection with their **concrete** zod schema, sharing only the
   payload-shaping helpers (`toKvRows` / `toKvKeys`). Insert and update both
   upsert the **whole** value (the items are tiny — no diffing); the Worker
   computes nothing from the value, and `key` is the collection's `getKey`. The
   collection interface is unchanged, so each file's `subscribeChanges` /
   `useSyncExternalStore` reactive read and all helpers are untouched.

4. **No shared generic factory.** A first cut tried a `createKvCollection<T>(...)`
   helper, but wrapping `queryCollectionOptions`' schema-overload in another
   generic loses the concrete schema type the overload needs to bind (it falls
   through to the no-schema overload and the item type widens to
   `Record<string, unknown>`). Passing the concrete schema at each call site (as
   `collection.ts` does for nodes) typechecks cleanly; the ~12 duplicated lines
   per collection are cheaper than fighting the inference.

## Sync cadence

Same as nodes: optimistic local writes, `{ refetch: false }` per handler, and
window-focus refetch (`query-client.ts`) for cross-device reconciliation. These
collections change rarely (pick a tag color, create a day), so focus-refetch is
ample.

## Rejected alternatives

- **A typed table per side-collection** — more code and migrations for no
  benefit; both are key→value. Revisit only if one grows real structure to query.
- **Generic `createKvCollection` factory** — see Decision 4: the type ergonomics
  don't pay off for two call sites.
- **Fold side data into the `nodes` table / a `Node` field** — rejected by ADR
  0016 / 0018 / 0019; this data is deliberately off the node schema.

## Known limitations / follow-ups

- **No localStorage → D1 import for side data.** The nodes import (ADR 0023,
  `import-legacy.ts`) does not carry over the old `dotflowy-oss:tag-colors` /
  `dotflowy-oss:daily-index` localStorage stores. Daily mappings self-heal
  (`goToDate` rebuilds a stale/absent mapping), so the practical gap is custom
  tag colors made before this change; a small import is a possible follow-up.
- **The e2e suite mocks `/api/kv`** (`e2e/fixtures.ts`) the same way it mocks
  `/api/nodes`; the Worker's kv SQL is covered by `typecheck:worker` + manual
  verification (the upsert / namespace-isolation / allowlist paths), not the
  Playwright run.
