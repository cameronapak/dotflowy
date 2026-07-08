---
status: accepted
---

# The per-user DO's storage stays native (transactionSync + a versioned migrator, not Effect SQL)

**Decision.** `UserOutlineDO` (`worker/outline-do.ts`) keeps talking to its colocated SQLite through the
raw Cloudflare `SqlStorage` handle, with `ctx.storage.transactionSync()` as the atomicity primitive
([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)). We do **not** adopt `@effect/sql-sqlite-do`
(the first-party Effect SQL adapter for Durable Objects). The two ergonomic gaps that adapter would have
closed are closed natively instead:

1. **Typed reads.** A `readRows<T>()` helper wraps `sql.exec(...).toArray()` so the row-shape casts
   (`as unknown as NodeRow[]`, `outline-do.ts`) live in one place instead of at every call site.
2. **A versioned migrator.** A `meta.schema_version` integer plus an ordered `MIGRATIONS` list replaces
   the constructor's ad-hoc `CREATE TABLE IF NOT EXISTS` block **and** the hand-rolled
   `PRAGMA table_info` / `ALTER TABLE mirrorOf` dance (ADR 0022). Each step runs once, inside a
   `transactionSync`, and bumps the version.

**Why not `@effect/sql-sqlite-do` (the surprising call, given we're already Effect-first).** The tempting
argument is symmetry: the Worker is a full Effect pipeline ([ADR 0012](./0012-effect-replaces-errore.md)),
the client is Effect-first ([ADR 0021](./0021-effect-first-one-schema-language.md)), so why is the DO the
one non-Effect island? And the vendor ships a blessed adapter, so it must fit. Reading its source
(`packages/sql/sqlite-do/src/SqliteClient.ts` in the opensrc-fetched effect-smol repo) settles it: the adapter's
`withTransaction` wraps the **async** `DurableObjectStorage.transaction(...)`, bridged through
`Effect.callback`, and its own docstring warns to *"keep transactions short, avoid suspending them across
unrelated work"*; nested transactions throw. Our node-write loop (`applyBatch`/`patchNodes`/`upsertNodes`/
`deleteNodes`) is **synchronous** — `transactionSync` fits it exactly, and CF documents that a throw in
the sync callback rolls the whole batch back. Swapping that for an async, permit-serialized transaction
with suspend points is an **atomicity regression** in the exact path ADR 0014 hardened against a torn
sibling chain. The adapter is built for DOs that are *already* Effect programs doing repositories +
migrations + streaming; ours is a synchronous RPC class. Right tool per layer, same as ADR 0014 — not
"Effect everywhere."

Note the reasons that are **not** load-bearing here: that the adapter leans on `effect/unstable/*`, or
rides the `beta.90` train, is no argument against it — we already ship exactly that beta and depend on
`effect/unstable/socket` (ADR 0013). The sole disqualifier is async-vs-sync transaction semantics.

**The migrator's one subtlety (why the baseline must be idempotent).** Already-deployed DOs have **no**
`schema_version` key — a fresh DO and a pre-versioning deployed DO both read "absent." So the **v1
baseline migration must be safe on both**: it is today's `CREATE TABLE IF NOT EXISTS` set plus the guarded
`mirrorOf` add, then set version = 1. From v2 onward every migration gets the clean guarantee of running
exactly once, so no future step needs a `PRAGMA` existence check. This idempotent-baseline / exactly-once-
tail split is the load-bearing invariant an agent would break by reaching for a naive exactly-once
migrator.

## Considered and rejected

- **`@effect/sql-sqlite-do` for the write path.** Rejected: async `storage.transaction` regresses the
  synchronous `transactionSync` critical section. See above.
- **`@effect/sql-sqlite-do`'s `SqliteMigrator` for schema only** (raw `sql.exec` for writes). Rejected:
  the migrator runs on the same async transaction machinery, and mixing two SQL access styles in one DO
  is worse for maintainability than either pure choice.
- **Keep the constructor's `CREATE TABLE IF NOT EXISTS` as a belt-and-suspenders baseline alongside the
  migrator.** Rejected: two schema-definition paths is the exact drift risk that produced the `mirrorOf`
  papercut. The v1 baseline migration *is* that block, moved — single source of truth.

## Consequences

- **The DO gains no new dependency.** Storage stays on the CF-native handle; atomicity stays on
  `transactionSync`; the migrator is ~20 lines of local code.
- **Schema evolution is now append-only.** The next schema change is a new `MIGRATIONS` entry, not another
  hand-rolled `PRAGMA`/`ALTER` in the constructor.
- **The row-shape casts collapse to one `readRows<T>()` seam.** No behavioral change; the SQL and the
  `rowToNode` mapping are untouched.
- **If the DO ever becomes an Effect program** (e.g. an Agents-SDK-style rewrite doing repositories +
  reactivity), revisit: at that point the adapter's async transaction is the *native* shape and this ADR's
  premise no longer holds.
