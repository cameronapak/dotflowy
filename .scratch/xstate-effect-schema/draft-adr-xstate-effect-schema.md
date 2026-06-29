---
status: draft
---

# DRAFT ADR — XState v6 state machines with Effect Schema contracts

> **Draft, not accepted.** This is a `.scratch` proposal. Per `CLAUDE.md`, a state-management
> primitive is an ADR-worthy decision (hard to reverse, surprising without context, a real
> trade-off) and must go through `/grill-with-docs` before it earns a numbered file in
> `docs/adr/`. Until then it lives here next to its PRD and the PoC code.

**What.** Adopt **XState v6** (`setup(...).createMachine(...)`, currently alpha) for dotflowy's
**discrete, imperative UI flows** — starting with node multi-selection — and type every machine's
`context` / `events` / actor `input`/`output` with **Effect Schema** via
`Schema.toStandardSchemaV1(...)`. One schema library (Effect, already our standard per ADR 0012/0014)
types both the data model and the machines; XState owns the control flow.

**Why XState, why only here.** The flows in `selection-mode.tsx`, `slash-menu.tsx`, and
`use-drag-reorder.ts` are literal state charts hand-rolled as imperative state + manual key
routing, where invalid transitions are reachable (can you extend a selection mid-drag?). A machine
makes the states, transitions, and guards explicit, visualisable, and unit-testable. It is
**scoped to those flows on purpose** — `tree-store`/`collection` (reactive dataflow), `view-state`
(two continuous values), and the Effect-scoped sync/retry resources (`realtime.ts`,
`kv-client-effect.ts`) are **not** discrete machines and stay as they are. XState models control
flow; Effect models resources; TanStack DB models synced data. This ADR draws that line.

**Why Effect Schema as the contract (not Zod, not `types<T>()`).** We already author the wire
contract as Effect Schema (`worker/wire.ts`, ADR 0014) and removed bespoke error libs for Effect
(ADR 0012). XState v6's `schemas` accept any Standard Schema, and `Schema.toStandardSchemaV1`
returns a value that is **both** an Effect schema and a Standard-Schema-v1 object, so the same
schema can validate at a boundary AND type a machine. Using Effect here keeps one schema vocabulary
across the worker and the client machines.

**The non-obvious facts an agent would get wrong from the code alone:**
- The React adapter for v6 is **`@xstate/react@7.0.0-alpha.1`** (npm `alpha` tag), **not**
  `@xstate/react@6` (which still targets xstate v5). Installing `@6` silently mismatches.
- In **Effect v4** the API is **`Schema.toStandardSchemaV1`**, not the v3 docs' `standardSchemaV1`.
- XState infers from the type-level `~standard.types` phantom, which Effect's return type carries
  even though the runtime object never sets it — so inference flows with no runtime `types` value.
- v6 `schemas` are **mostly compile-time** today (runtime validation "where supported"; logic
  creators type-only for now). Effect Schema here is the **type source of truth**, not a runtime
  guard — it does **not** replace `worker/wire.ts`.

**Model (selection PoC).** Machine context `{ parentId, anchorId, focusId, rootIds }`; states
`idle → single → multi`. Transitions are v6 inline functions returning `{ target, context }`.
The tree-dependent input (visible sibling ids) is passed **into** events as a `siblings` snapshot,
keeping the machine **pure** — the editor adapter reads the live tree and feeds the machine. This
preserves the architecture's existing seam (impure reads at event time, pure state) rather than
pulling the tree into the machine.

**Invariants to keep (don't regress):**
- Per-row reads stay per-node (`useSelector(actor, …)` mirrors `useSelectionEdge`'s
  `useSyncExternalStore`) so a selection change re-renders only the rows entering/leaving it
  (ADR 0014's budget). **Never** thread selection/machine state as a prop.
- Every multi-node mutation stays **one `runStructural` batch** (ADR 0009). The machine orchestrates
  *intent*; the structural write still goes through `structural.ts`.
- Keep machines **off the contentEditable hot path**; respect `OutlineEditor`'s `"use no memo"`
  (ADR 0019).

**Rollout.** Behind the `isSelectionMachine()` flag (default off), parallel to the live singleton,
proven at parity in `e2e/node-multi-select.spec.ts`, then singleton + flag deleted together — the
same dogfood-then-delete discipline as ADR 0019's `virtualized` flag.

**Alternatives considered.**
- **Keep the module-singleton + `useSyncExternalStore` status quo.** It ships well and is the
  default if the PoC doesn't earn its keep; the cost is the implicit, untestable transition logic.
- **`@xstate/store` instead of full XState.** Lighter, but it's a typed event store, not a
  statechart — it wouldn't model the `idle/single/multi` transitions or guards we want.
- **Zod for the schemas.** We have `zod@4` and XState accepts it, but it splits the schema
  vocabulary from the Effect-everywhere worker contract.

**Don't:** install `@xstate/react@6` for xstate v6; call `Schema.standardSchemaV1` (v3 name);
expect `schemas` to validate request bodies at runtime (that's still `worker/wire.ts`); thread the
actor through props; route a multi-node mutation outside `runStructural`; or adopt beyond the
flagged PoC before this draft goes through `/grill-with-docs`.
