---
status: accepted
---

# Validate the Worker→DO trust boundary (Effect Schema for input, CF-native transaction for atomicity)

**Decision.** Two coordinated fixes harden the boundary between the Worker and the per-user Durable
Object — one robustness gap, addressed with the right tool on each side:

1. **Validation (Effect Schema, Worker-side).** Every `/api/nodes` and `/api/kv` request body is
   decoded against an Effect Schema at the Worker boundary (`worker/wire.ts`, run by `decodeBody` in
   `worker/index.ts`). A malformed body fails into a typed `BadRequest` → one `catchTag` → clean **400**.
   The Worker's `Node`/`ChangeOp` types are **derived** from those schemas (`Schema.Schema.Type<…>`),
   so the validator and the type the DO trusts cannot drift.
2. **Atomicity (Cloudflare-native, DO-side — deliberately NOT Effect).** Each DO node mutation
   (`applyBatch`, `upsertNodes`, `patchNodes`, `deleteNodes`) wraps its SQL — the row writes **and** the
   seq bump + changelog row — in one `ctx.storage.transactionSync()`. The WebSocket broadcast moved
   _out_ of the SQL step (`commitChange` split into `recordChange` + `broadcastChange`) so a frame is
   emitted only after the transaction commits.

**Why.** The boundary trusted the client. Every handler did `(await request.json()) as {…}` with zero
runtime enforcement, so a malformed body (e.g. `{ ops: [{ op: "insert" }] }`, no `value`) sailed through
the cast, reached the DO, and dereferenced `undefined` deep inside the SQLite write loop — a 500 from
inside storage. And `applyBatch` looped with no transaction: a throw on op 3 of 5 left ops 1–2 written
and `commitChange` unreached → a torn sibling chain with no seq and no broadcast. That is the exact
half-applied tear [ADR 0009](./0009-atomic-structural-writes.md) prevents on the client, relocated to
the server; the all-or-nothing guarantee was real only because the input was implicitly trusted.
Validation removes the _common_ cause of a mid-loop throw (bad input); the transaction covers the
_residual_ (a genuine SQLite fault on valid input). Together: a bad body never reaches the DO, and if a
write faults anyway, the batch rolls back whole.

**Why the split — Effect for validation, CF-native for atomicity (the surprising call).** The Worker is
already a full Effect pipeline ([ADR 0012](./0012-effect-replaces-errore.md)), so a Schema decode
failure slots into the _existing_ typed-error channel with no new machinery — `decodeUnknownEffect`
fails with `SchemaError`, mapped to `BadRequest`, caught beside `UnknownCollection`/`RouteNotFound` at
the one outer boundary. But the DO is **not** an Effect program, and atomicity is a storage-engine
concern, not an error-modeling one. Pulling Effect's runtime (or STM) into the DO to wrap a synchronous
SQLite loop would be heavyweight and buy nothing CF doesn't already give: `transactionSync` _is_ the
rollback primitive. Right tool per layer, not "Effect everywhere."

**Why `transactionSync`, and why the implicit path is not enough.** CF's docs guarantee that if the
`transactionSync` callback throws, the transaction rolls back. The implicit guarantee — "writes with no
intervening `await` are submitted atomically" — is about _durability batching_, and the docs are silent
on whether an uncaught throw mid-loop rolls back the writes already applied to the DO's **in-memory**
SQLite. They do not, in general: the live instance stays torn and the next `getNodes()` reads it.
`transactionSync` is the explicit primitive that closes that, so we use it rather than rely on implicit
behavior the docs don't promise.

## Considered and rejected

- **Decode inside the DO methods, not at the Worker boundary.** Rejected: the DO should stay _total_
  over already-valid input; the trust boundary is where untrusted JSON enters (the Worker), and
  rejecting there means a bad body never costs a DO round-trip.
- **Hand-written `Node`/`ChangeOp` types with a parallel schema.** Rejected: deriving the type _from_ the
  schema makes drift impossible — the validator is the type. (This ADR originally kept the client's copy
  in `src/data/realtime.ts` hand-written, reasoning "a different tsconfig, no Effect at the type layer."
  **That reason was later proven false and this is reversed:** `realtime.ts` already imports Effect
  heavily, and a shared `effect/Schema` module was demonstrated to typecheck under _both_ the app tsconfig
  (DOM lib) and the Worker tsconfig (workers-types, no DOM). The wire types now derive from one shared
  `src/data/wire-schema.ts` imported by both sides, which also lets the client Schema-validate inbound
  DO→client frames — the "higher-value pass" [ADR 0013](./0013-sync-socket-as-an-effect-resource.md)
  anticipated. The client is still the originator; the Worker is still the gate.)
- **Zod (then the client's schema library) instead of Effect Schema.** Rejected: zod wasn't in the
  Worker bundle, and its failures wouldn't compose with the Worker's Effect error channel — Effect
  Schema decodes straight into it. (Moot since: the client's data-layer schemas also moved to Effect
  Schema and zod was removed from the project entirely — see [ADR 0003](./0003-no-schema-defaults.md)
  and [ADR 0021](./0021-effect-first-one-schema-language.md). Effect Schema is now the one schema
  language across client and Worker.)
- **Effect runtime / STM transaction in the DO for atomicity.** Rejected as over-engineering: see the
  split rationale above. `transactionSync` is the native, synchronous fit for a synchronous loop.
  ([ADR 0023](./0023-do-storage-stays-native.md) revisits this specifically for the first-party
  `@effect/sql-sqlite-do` adapter and rejects it for the same reason — its `withTransaction` wraps the
  **async** `storage.transaction`, a regression from this synchronous critical section.)

## Consequences

- **The Worker bundle gains Effect Schema** (~491 KiB gzip total, well within CF's compressed limit) —
  incremental on top of the already-bundled Effect core, not a new runtime.
- **The decode path is not covered by e2e.** The `seedOutline` mock (`e2e/fixtures.ts`) fakes the Worker
  in-memory and never runs `worker/index.ts`/`outline-do.ts`, so the new gate is a pure `bun test`
  (`worker/wire.test.ts`: valid bodies decode, the malformed shapes reject) — the same pure-logic tier
  as the sync socket's `realtime.test.ts`. Run via `bun test src worker/`; typechecked via
  `tsconfig.test.json`.
- **kv writes are not yet transactional.** `upsertKv`/`deleteKv` loop without `transactionSync`. They
  have no changelog and no broadcast, so a partial kv write cannot tear the realtime sync stream — lower
  stakes, deferred rather than done in this pass.
- **The happy path is unchanged.** Valid requests behave identically; `applyBatch` still returns the
  committed seq for the client's echo-hold (ADR 0009). The hardening is invisible until a body is
  malformed or a write genuinely faults.
