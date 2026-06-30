---
status: accepted
---

# Effect is the default; Effect Schema is the one schema language

**Decision.** Effect is dotflowy's **default** library. When a job is in Effect's wheelhouse —
schema/validation, typed errors, async I/O with retry/timeout, scoped resources, streams — reach for
Effect first rather than a single-purpose alternative. The concrete first application of this posture:
**Effect Schema is the single schema language across the client *and* the Worker, and zod is removed
from the project entirely.** `src/data/schema.ts` (the `Node` schema + type), `tag-colors.ts`, and the
daily index now use `Schema.Struct`/`Schema.Schema.Type`, mirroring the Worker's `worker/wire.ts`
([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)). TanStack DB consumes them through one
adapter call, `Schema.toStandardSchemaV1(schema)`, at each `createCollection` site.

**Why.** One schema language instead of two. The Worker was *already* Effect Schema (it had to be —
its decode failures compose into the Worker's Effect error channel, [ADR 0012](./0012-effect-replaces-errore.md)),
so the client running zod meant two validators, two type-derivation idioms, and two mental models for
the same `Node` shape that crosses the wire. Unifying on Effect Schema collapses that: the encoded type
*is* the collection's item type, derivation is `Schema.Schema.Type<…>` on both sides, and the
no-defaults rule has one explanation ([ADR 0003](./0003-no-schema-defaults.md)). The broader Effect-first
default is the same logic generalized — every place we'd otherwise pull a second library for retry,
timeouts, tagged errors, or resource lifecycle is a place the codebase already speaks Effect, so a
second tool is net new surface area to learn and keep in lockstep.

**The bounded exception — right tool per layer (load-bearing, not a loophole).** "Effect-first" is a
default, not "Effect everywhere, no exceptions." The standing precedent is
[ADR 0014](./0014-validate-the-worker-do-trust-boundary.md): the per-user DO's write **atomicity** uses
CF-native `ctx.storage.transactionSync()`, **not** Effect/STM — the DO is not an Effect program and
atomicity is a storage-engine concern, so pulling in Effect's runtime would be heavyweight and buy
nothing CF doesn't already give. Likewise the `kv-api.ts` **throw-shells** stay throw-shaped because
TanStack DB signals failure by throwing ([ADR 0012](./0012-effect-replaces-errore.md)). The default is
strong; the escape hatch is "a different layer's native primitive is the genuine fit," and using it is a
deliberate, recorded call — not a drift back to a second general-purpose library.

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
- **The Effect-first default is now a recorded posture**, so reaching for Effect in new modules needs no
  re-litigation — but invoking the right-tool-per-layer exception (as 0014 did) should be a conscious,
  noted choice, not silent.
- This ADR records *that* the standardization happened and *why zod was rejected*, so the choice stays
  rejected; the mechanics (the `toStandardSchemaV1` wrap, the no-defaults rule) live in the code and in
  ADRs 0003/0014.
