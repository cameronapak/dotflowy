---
status: accepted
---

# Node selection as an XState v6 machine

**What.** Model node multi-selection ([ADR 0018](./0018-node-multi-selection.md)) as an **XState v6
state machine** whose **context + events are typed by Effect Schema** (`Schema.toStandardSchemaV1` →
XState's Standard Schema slots), backing the existing `src/data/selection-state.ts`. The machine is a
**module-singleton actor** (`createActor(...).start()`, mirrored like `view-state.ts`), not a
`useMachine` — its public API (`selectSingle`/`extendSelection`/`selectAllInView`/`refreshSelection`/
`clearSelection`/`getSelectionState`/`getSelectionRootIds`/`isSelectionActive`/`isWholeViewSelected`/
`subscribeSelection`/`useSelectionEdge`) is **byte-for-byte unchanged**, so every consumer
(`selection-mode.tsx`, the rows, `use-bullet-keymap.ts`) is untouched and a rollback is "restore the
old file + `bun remove xstate @xstate/react`."

**Why here, and not the sync socket.** The genuinely good XState target is a place where state is
**currently implicit and the cost of getting it wrong is real**, *and* where converting doesn't
churn working code. Selection qualifies on both: it is a true two-mode machine (`idle` = a text
caret, no selection; `selecting` = a run of nodes, no caret), and the while-selected keyboard is pure
event-routing-by-state — making that explicit is the legibility win. It is **UI-local and
e2e-covered** (`node-multi-select.spec.ts`, 17 cases), so the conversion is a safe, provable
experiment. The sync socket (`realtime.ts`, [ADR 0013](./0013-sync-socket-as-an-effect-resource.md))
is the textbook *shape* but the wrong *target*: it is already a clean, tested Effect resource, so an
XState rewrite there is churn, not value.

**Why Effect Schema, and what it does NOT do.** v6 takes Standard Schema, and Effect Schema flows in
via `toStandardSchemaV1` — the same bridge the codebase already uses to feed schemas to TanStack DB
(`collection.ts`). It is a **type source** here, not a runtime guard: selection has no untrusted
input (no wire, no async, no user-supplied payload), so there is nothing to validate at runtime. The
value is that the event union and context shape are defined once, in Schema, and XState infers the
rest. This is the honest scope of the "XState + Effect Schema" combo *for this feature* — for the
runtime-validation half of that combo, the real home is the sync frame decode (ADR 0013's open
`decodeFrame` pass), not here.

**The two-state-with-nullable-context call (deliberate, not the maximal version).** v6 supports
*per-state context narrowing* (a field that exists only in one state's type), which would make
`parentId`/`anchorId`/`rootIds` literally unreadable at the type level while `idle`. We did **not**
use it. The context is a single `{ data: SelectionData | null }`; `idle` carries `data: null`,
`selecting` carries the run. Reasons: (1) per-state context typing is the most alpha, least-documented
surface in v6-alpha, and the project bar is "tests pass before shipping" — a robust green beats a
fragile maximal; (2) the **behavioral** guarantee is already there at runtime (`idle` genuinely holds
`data: null`, and `isSelectionActive()` keys off the state value, not the field); (3) the
**event-level** narrowing — which *is* robust — already lands the safety that matters: `extend` and
`refresh` exist **only** in the `selecting` state, so a stray `Shift+arrow` can't no-op into a bug,
and entering selection is the only path that can produce a run. Tightening `{ data: ... | null }`
into true per-state context is a type-only follow-up that changes no behavior.

**Why a module-singleton actor + `useSelector`, never `useMachine`.** An XState actor is a
subscribable external store — exactly the hand-rolled `Set<listener>` + `useSyncExternalStore` the old
file had. `useSelector(actor, s => edgeOf(id, s.context.data), Object.is)` is the per-node slice
subscription: it runs the selector on every snapshot but re-renders a row only when *its* edge
primitive changes, preserving [ADR 0014](./0004-localized-rendering-via-the-tree-store.md)'s
per-node-render budget. A `useMachine` in a component would bind selection to one component's render
and blow that budget — the one wiring that would defeat the whole reason this design exists.

**The tree derivation stays imperative — XState doesn't fix it.** The hard logic (mirror the render's
visible prune; at a sibling boundary, a single-root run walks by depth while a multi-root run no-ops;
re-derive from the live collection inside a `runStructural` batch) lives in pure helpers
(`computeRange`/`computeExtend`/`computeAllInView`) that the transitions call at **event time** via
the live getters (`getTreeIndex`/`getViewRootId`/...), the [ADR 0004](./0004-localized-rendering-via-the-tree-store.md)
idiom. The machine isn't a self-contained pure statechart — the tree is ambient input. XState cleaned
up the *mode + keyboard-routing*; it did not dissolve the derivation, and was never going to.

**Don't regress:**
- Keep the public API of `selection-state.ts` frozen — the swap's whole safety story is that
  consumers never changed. Add a method only if a consumer needs it.
- Module-singleton actor + `useSelector` for per-node reads. Never `useMachine`, never thread
  selection as a prop ([ADR 0014](./0004-localized-rendering-via-the-tree-store.md)).
- `useSelectionEdge` must return the **edge primitive** through `useSelector`'s compare, so a
  selection change re-renders only the rows whose edge actually changed.
- Transitions read the live tree at event time (getters), not render-time values; a no-op transition
  returns nothing so the context reference is preserved (which is what keeps `getSelectionRootIds`'s
  snapshot stable for `useSyncExternalStore`).
- `xstate@6` / `@xstate/react@7` are **alpha**, accepted because dotflowy has one user and e2e gates
  every ship. Treat a version bump as a real change: re-run `node-multi-select.spec.ts`.

**Shipped (typecheck + lint clean; `node-multi-select.spec.ts` 17/17; full e2e 84/86 with the 2 the
known `daily-notes` flake, 16/16 serial).** Deps added: `xstate@6.0.0-alpha.12`,
`@xstate/react@7.0.0-alpha.1` (peer-compatible with React 19 and `effect@4`).
