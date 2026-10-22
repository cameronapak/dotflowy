---
status: accepted
---

# Effect is the default; Effect Schema is the one schema language

**Decision.** Effect is dotflowy's **default**, and the default is strong: **any code that performs an
_effect_ — async I/O, error handling, retry/timeout, resource lifecycle, concurrency,
schema/validation — is written in Effect, not a single-purpose alternative and not hand-rolled
`Promise`/`fetch`/`setTimeout` machinery.** The inverse is what bounds it: **pure logic stays pure.**
Wrapping a side-effect-free function (`buildTreeIndex`, `tags.ts`, `links.ts`) in `Effect.succeed` is
ceremony, not tightness, and is not wanted — Effect earns its place only where there is something to
fail, retry, time out, cancel, or sequence. "Can it be Effectful?" is the wrong test; "is it an
effect?" is the right one.

The concrete first application of this posture: **Effect Schema is the single schema language across
the client _and_ the Worker, and zod is removed from the project entirely.** `src/data/schema.ts` (the
`Node` schema + type), `tag-colors.ts`, and the daily index now use `Schema.Struct`/`Schema.Schema.Type`,
mirroring the Worker's `worker/wire.ts` ([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)).
TanStack DB consumes them through one adapter call, `Schema.toStandardSchemaV1(schema)`, at each
`createCollection` site.

**Why.** One schema language instead of two. The Worker was _already_ Effect Schema (it had to be —
its decode failures compose into the Worker's Effect error channel, [ADR 0012](./0012-effect-replaces-errore.md)),
so the client running zod meant two validators, two type-derivation idioms, and two mental models for
the same `Node` shape that crosses the wire. Unifying on Effect Schema collapses that: the encoded type
_is_ the collection's item type, derivation is `Schema.Schema.Type<…>` on both sides, and the
no-defaults rule has one explanation ([ADR 0003](./0003-no-schema-defaults.md)). The broader Effect-first
default is the same logic generalized — every place we'd otherwise pull a second library for retry,
timeouts, tagged errors, or resource lifecycle is a place the codebase already speaks Effect, so a
second tool is net new surface area to learn and keep in lockstep.

**The boundaries — bridge, don't leak (load-bearing, not a loophole).** "Effect-first" is a strong
default, not "Effect leaks into every runtime." Three seams stay non-Effect-_shaped_ at the surface, but
only **one** is a true exemption; the other two are Effect underneath with a one-line bridge:

- **Genuine exemption — the DO's write atomicity** ([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)).
  The per-user DO uses CF-native `ctx.storage.transactionSync()`, **not** Effect/STM. The DO is not an
  Effect program and atomicity is a storage-engine concern; Effect's runtime there is heavyweight and
  buys nothing CF doesn't already give.
- **Effect underneath, throw at the seam — the TanStack mutation handlers**
  ([ADR 0012](./0012-effect-replaces-errore.md)). `kv-api.ts` / `api.ts` handlers stay throw-shaped
  because TanStack DB signals failure by _throwing_ (a throw triggers optimistic rollback). They run an
  Effect program through `runPromise`; the throw is the one-line bridge, **not** an absence of Effect.
- **Effect underneath, Promise at the seam — React event handlers.** A click/keydown handler can't
  `await` an Effect value, so it bridges with `runPromise`/`runFork`. The long-lived sync fiber in
  `collection.ts` is the model: fork **once** at the right altitude, don't sprinkle a `runPromise` per
  keystroke.

The discipline: Effect goes **all the way down** to each seam; the bridge is a deliberate, recorded call
at exactly one altitude — not a drift back to raw `Promise`/`fetch` machinery, and not Effect leaking
past a boundary another runtime owns (which would break rollback or bloat the DO).

## Considered and rejected

- **Keep zod on the client, Effect Schema only at the Worker boundary** (the state that existed). Rejected:
  two schema languages for one wire-crossing `Node`, kept in lockstep by hand — the dual-validator tax
  with no offsetting benefit once `toStandardSchemaV1` proved Effect Schema drives a TanStack DB collection
  cleanly.
- **Keep zod as the project's general schema lib and treat the Worker as the special case.** Rejected:
  it inverts the gravity. The Worker's Effect requirement is structural (its error channel); the client's
  zod was incidental. Standardizing on the structural one removes a dependency instead of entrenching it.

## Consequences

- **zod is gone** from `package.json` and `src/`; don't reintroduce it. New schema/validation work uses
  Effect Schema.
- **New effectful code is Effect; pure logic is not wrapped.** Async I/O, error handling, retry/timeout,
  resource lifecycle, and concurrency go through Effect. Hand-rolled `Promise`/`fetch`/`setTimeout` for
  an effect Effect already models is a defect to convert, not a style choice — the standing backlog of
  such conversions is tracked in `.scratch/effect-tightening/`.
- **The Effect-first default is now a recorded posture**, so reaching for Effect in new modules needs no
  re-litigation — but invoking the genuine exemption (as 0014 did) should be a conscious, noted choice,
  not silent.
- This ADR records _that_ the standardization happened and _why zod was rejected_, so the choice stays
  rejected; the mechanics (the `toStandardSchemaV1` wrap, the no-defaults rule) live in the code and in
  ADRs 0003/0014.
