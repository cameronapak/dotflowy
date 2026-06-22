# ADR 0016: Jazz as the local-first + sync backend

Status: accepted (2026-06-22), **implemented**. Supersedes the Turso/libSQL
direction recorded in [ADR 0015](./0015-scaling-roadmap-o1-write-path.md) and
PLAN.md for the storage/sync layer. ADR 0015's *diagnosis and the O(1)
write-path invariant still stand*; only the chosen backend changes.

## Glossary

- **Jazz 2.0** — `jazz-tools` (alpha at time of writing). A local-first runtime:
  WASM query engine, OPFS persistence in the browser, synchronous local-first
  writes, and last-write-wins-per-field merge built in. Server-side persistence
  is Fjall (a Rust LSM), not SQL.
- **LWW per field** — last-write-wins, resolved per column on a row. Jazz's
  default merge strategy. The conflict model ADR 0015 settled on, now provided by
  the backend instead of hand-rolled on `updatedAt`.
- **Soft delete / tombstone** — `db.delete` marks a row deleted rather than
  removing it; `restore` revives it and `includeDeleted()` queries see it.
  Default queries exclude tombstones.

## Context

ADR 0015 sequenced a foundation-first plan on **Turso / libSQL** with a
hand-rolled LWW-on-`updatedAt` conflict model, a custom TanStack DB `SyncConfig`
adapter, and an offline outbox. A working Jazz 2.0 spike (branch
`spike/jazz-sync`) then showed Jazz supplies the load-bearing pieces of that plan
**out of the box**:

- per-field LWW (ADR 0015 D4) — built in, not per-row.
- soft-delete tombstones (D5) — built in (`delete` + `restore`).
- durable local persistence + cross-tab coordination — built in (OPFS + Worker).
- offline writes that reconcile on reconnect — the runtime's model.

The cost: Jazz's server persistence is Fjall, which **forecloses the
queryable-per-tenant-SQLite goal** ADR 0015 leaned on (Turso's headline feature).
Cam weighed that and chose Jazz: the conflict-safety and offline correctness it
hands us for free outweigh the SQL-per-tenant story, which was a *future* nicety,
not a current requirement.

## Decision

Replace the TanStack DB `localStorageCollection` with Jazz 2.0 as the single
data layer. Anonymous local-first today (no account, OPFS-persistent); a Jazz
server URL + auth turns on device sync later without touching components.

**What was built (this change):**

- `schema.ts` — a Jazz `nodes` table + `app`; `Node` kept as an explicit type so
  the rest of the app is uncoupled from Jazz generics. `parentId`/`prevSiblingId`
  are plain TEXT (self-referential; order is resolved in `buildTreeIndex`, so we
  deliberately avoid Jazz's relation machinery). Timestamps are `float` (f64), not
  `int` (i32 overflows on epoch-ms — see Rough edges).
- `jazz.ts` — the client as a lazy **module singleton** (`createDb`, anonymous
  local-first via `BrowserAuthSecretStore`, persistent OPFS driver). `whenDbReady()`
  / `getDb()` / a `useDbReady()` gate. A one-time, idempotent import of the legacy
  `dotflowy-oss:nodes` localStorage doc (D8), and first-run seeding, both decided
  here before any paint.
- `tree-store.ts` — one `db.subscribeAll(app.nodes, …)` feeds the existing shared
  `TreeIndex`; the public hooks (`useNode` / `useVisibleChildIds` / `useTreeIndex`)
  are unchanged. Jazz hands back fresh row objects per delta, so the store applies
  the delta's row-change stream to a persistent `byId` map to **preserve object
  identity for unchanged rows** — the invariant ADR 0014's localized rendering
  depends on.
- `mutations.ts` / `history.ts` / `seed.ts` — same logic, writing through
  `getDb()` instead of the collection. Undo stays snapshot-based (correct for
  single-device; resurrects deleted rows via `restoreNode`).

**Why the module singleton, not `<JazzProvider>` + `useDb()`:** the whole data
layer (mutations, history, seed, tree-store) is non-React module code that needs
`db` synchronously. A provider would force threading `db` through React into all
of it. The singleton keeps that code, and ADR 0014's seam, intact; React only
consumes the ready signal.

### Resolved / changed decisions from ADR 0015

| ADR 0015 item | Outcome under Jazz |
|---|---|
| D4 per-field LWW | Provided by Jazz. |
| D5 deletes/resurrection | Soft-delete + `restore`, built in. |
| D3 LWW-on-a-tree cycles | **Still ours.** Jazz won't prevent structural cycles; `buildTreeIndex`'s cycle guard + orphan recovery stay. |
| D1 cross-origin isolation | Not hit yet — the current OPFS path boots without COOP/COEP. Re-evaluate if a future Jazz/SAB path requires it. |
| D2 anonymous-then-account | Anonymous local-first now; signup adds serverUrl/JWT later. |

### Out of scope (still ADR 0015's roadmap)

Fractional `sortKey` (still `prevSiblingId`), inverse-patch undo, and
virtualization are unchanged by this swap — one migration at a time.

## Verification

`bun run typecheck` clean (pre-existing `ui/form.tsx` dep errors aside). Driven
in a real browser: WASM/OPFS boot, first-run seed, render via subscription, an
edit **persists across a full reload** (OPFS round-trip), insert via Enter, and
Cmd+Z undo all confirmed. No test runner (AGENTS.md).

## Rejected / deferred alternatives

- **Turso / libSQL + custom TanStack DB adapter (ADR 0015's plan)** — rejected:
  Jazz provides per-field LWW, tombstones, offline reconcile, and local
  persistence without the hand-rolled adapter + outbox.
- **`<JazzProvider>` + `useDb()`** — rejected: see "Why the module singleton".
- **Storing timestamps as Jazz `timestamp` (Date) columns** — rejected: would turn
  `Node`'s `number` fields into `Date` across the app. `float` keeps them `number`.

## Sync configuration (env-driven)

`src/data/jazz.ts` reads `VITE_JAZZ_APP_ID` and `VITE_JAZZ_SERVER_URL` from the
env (`.env`, gitignored; shape in `.env.example`). Set the server URL and the
client syncs to that Jazz server; unset, it stays local-only. The non-`VITE_`
secrets (`JAZZ_ADMIN_SECRET`, `BACKEND_SECRET`) are server-only and never enter
the client bundle — they authorize the **schema + permissions publish**:

```sh
# one-time per schema/permissions change; reads JAZZ_ADMIN_SECRET + *_SERVER_URL from env
node node_modules/jazz-tools/dist/cli.js deploy "$VITE_JAZZ_APP_ID" --schema-dir src/data
```

`--schema-dir src/data` is required because our `schema.ts` / `permissions.ts`
live there, not at the default root. `permissions.ts` is owner-scoped
(`policy.nodes.managedByCreator()`) — without it the enforcing server runtime
defaults to DENY on every op and data never syncs.

## Known rough edges / open questions

- **`CatalogueWriteDenied` WARN persists even after `deploy`.** Once the schema +
  permissions are published by the admin (hash `557c19c3ccb0`, permissions v1), the
  client hash matches the server, yet the non-admin client still logs one
  `CatalogueWriteDenied` per connect (on branch `main`) — it optimistically
  re-writes the catalogue the admin already owns, and is refused. Benign: data
  writes succeed (see below), the app reads the published catalogue and runs.
- **Data sync is live and verified for the owner.** Inserts/updates/deletes reach
  the server on branch `dev-557c19c3ccb0-main`; a normal online create→delete
  produces no permission errors, confirming `managedByCreator`. Not yet shown
  *cross-device* — with only a per-device anonymous secret, two devices are two
  owners, so the policy (correctly) keeps their data apart. The cross-device demo
  is gated on auth (below).
- **Stale-tombstone delete denials (resolved).** Rows created *and* deleted before
  sync was configured queued delete ops the server rejected (`PermissionDenied …
  "Delete denied … missing row content"` — the server never got their inserts, so
  ownership can't be checked). Cleared once with `db.deleteClientStorage()` (dev
  hook: `window.__jazzDb` when `import.meta.env.DEV`). **Open:** whether Jazz
  coalesces an *offline* create-then-delete so this can't recur in normal use —
  verify alongside offline-reconnect.
- **Auth/identity still doesn't exist** (ADR 0015 D2) — the real prerequisite for
  one user's devices to share an owner and actually sync cross-device. Not part of
  this change.
- **Jazz is alpha.** Pin the exact version; API churn is expected. Re-verify
  offline-reconnect and tombstone GC before relying on sync.
- **i32 timestamp trap** — documented in AGENTS.md; `int` columns silently invite
  the same overflow for any future epoch-ms field.
