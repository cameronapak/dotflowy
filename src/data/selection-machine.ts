import { Schema } from 'effect'
import { setup } from 'xstate'

/**
 * Node multi-selection (ADR 0018) as an XState v6 machine whose context + events
 * are typed with **Effect Schema**. Driven behind the `isSelectionMachine()` flag
 * by `selection-state.ts` (the singleton stays the default). See
 * `.scratch/xstate-effect-schema/` for the design + draft ADR.
 *
 * Integration showcase:
 *
 * 1. **Effect Schema -> XState `schemas`.** `Schema.toStandardSchemaV1(s)` turns
 *    an Effect schema into a Standard-Schema-v1 object; XState v6 `schemas` accept
 *    any Standard Schema and infer context/event types from the type-level
 *    `~standard.types` phantom Effect's return type carries. GOTCHA: Effect **v4**
 *    spells it `toStandardSchemaV1` (the v3 docs' `standardSchemaV1` is gone).
 *
 * 2. **Type-only today.** v6 `schemas` mostly drive *type inference*, not runtime
 *    validation. So this is the single source of truth for the selection *types*;
 *    it does NOT replace the boundary validation in `worker/wire.ts`.
 *
 * 3. **Tree-dominated -> the machine classifies, the adapter computes.** Every
 *    selection transition depends on the live tree (which siblings are visible,
 *    the depth-walk at a boundary). So the adapter (`selection-state.ts`) reads
 *    the tree and hands the machine the visible sibling ids; the machine
 *    normalizes the run via `rangeFrom` and classifies `idle/single/multi`. The
 *    same `rangeFrom`/`buildEdgeMap` power the singleton backend, so both paths
 *    compute identically (parity by construction). This is the honest finding:
 *    for tree-dominated features the machine's value is state classification + a
 *    single Effect-Schema-typed source of truth, not owning pure transition logic.
 */

/** Where a selected ROOT sits in the slab (mirrors ADR 0018). */
export type SelectionEdge = 'top' | 'bottom' | 'middle' | 'single'

// --- Effect Schema: the single source of truth for the machine's types --------

/** The selection run, mirroring `SelectionState` in `selection-state.ts`. A
 *  transform-free Struct, so `Encoded === Type` and XState infers exactly this. */
const SelectionContextSchema = Schema.Struct({
  /** Shared parent of the run (sibling-scoped); null at the top level. */
  parentId: Schema.NullOr(Schema.String),
  /** The fixed end of the run; null only when idle. */
  anchorId: Schema.NullOr(Schema.String),
  /** The moving end; null only when idle. */
  focusId: Schema.NullOr(Schema.String),
  /** Selected sibling roots in visible order, anchor..focus inclusive. */
  rootIds: Schema.Array(Schema.String),
})

/** The decoded context type, derived from the schema (never hand-written). */
export type SelectionContext = Schema.Schema.Type<typeof SelectionContextSchema>

/** Set the run from tree facts: the visible sibling ids under `parentId` plus the
 *  desired anchor/focus. The machine derives `rootIds` via `rangeFrom`. */
const SelectRangeEvent = Schema.Struct({
  parentId: Schema.NullOr(Schema.String),
  anchorId: Schema.String,
  focusId: Schema.String,
  /** Visible sibling ids under `parentId`, in display order (tree snapshot). */
  siblings: Schema.Array(Schema.String),
})

/** Local alias for the v4 bridge — see the GOTCHA in the file header. */
const std = Schema.toStandardSchemaV1

// --- pure helpers, shared by BOTH backends (one source of truth) -------------

/** The inclusive sibling run between `anchorId` and `focusId` within `siblings`,
 *  collapsing to the anchor if focus isn't visible. Null if the anchor itself is
 *  gone. Mirrors `selectRange` in `selection-state.ts`, minus the tree read. */
export function rangeFrom(
  siblings: readonly string[],
  anchorId: string,
  focusId: string,
): { focusId: string; rootIds: string[] } | null {
  const ai = siblings.indexOf(anchorId)
  if (ai === -1) return null
  let fi = siblings.indexOf(focusId)
  if (fi === -1) fi = ai
  const lo = Math.min(ai, fi)
  const hi = Math.max(ai, fi)
  return { focusId: siblings[fi]!, rootIds: siblings.slice(lo, hi + 1) }
}

/** Map each selected root id to its slab edge. The first/last get rounded outer
 *  corners, a lone root rounds all four, middles round nothing (ADR 0018). */
export function buildEdgeMap(rootIds: readonly string[]): Map<string, SelectionEdge> {
  const m = new Map<string, SelectionEdge>()
  if (rootIds.length === 0) return m
  if (rootIds.length === 1) {
    m.set(rootIds[0]!, 'single')
    return m
  }
  m.set(rootIds[0]!, 'top')
  m.set(rootIds[rootIds.length - 1]!, 'bottom')
  for (let i = 1; i < rootIds.length - 1; i++) m.set(rootIds[i]!, 'middle')
  return m
}

/** A fresh idle context (never share the reference across transitions). */
function idleContext(): SelectionContext {
  return { parentId: null, anchorId: null, focusId: null, rootIds: [] }
}

/** The SELECT_RANGE transition body, shared by every state's handler (one typed
 *  function so there's no per-state duplication and inference still flows). The
 *  event carries `type` too, but structural typing lets it satisfy this input. */
function applyRange(event: {
  parentId: string | null
  anchorId: string
  focusId: string
  siblings: readonly string[]
}): { target: 'idle' | 'single' | 'multi'; context: SelectionContext } {
  const r = rangeFrom(event.siblings, event.anchorId, event.focusId)
  if (!r) return { target: 'idle', context: idleContext() }
  return {
    target: r.rootIds.length === 1 ? 'single' : 'multi',
    context: {
      parentId: event.parentId,
      anchorId: event.anchorId,
      focusId: r.focusId,
      rootIds: r.rootIds,
    },
  }
}

/** CLEAR transition body. */
function clearToIdle(): { target: 'idle'; context: SelectionContext } {
  return { target: 'idle', context: idleContext() }
}

// --- the machine -------------------------------------------------------------

const { createMachine } = setup({
  schemas: {
    context: std(SelectionContextSchema),
    events: {
      SELECT_RANGE: std(SelectRangeEvent),
      CLEAR: std(Schema.Struct({})),
    },
  },
})

/**
 * `idle → single → multi`. Caret and selection are mutually exclusive (ADR 0018);
 * `idle` is the caret world. The transitions are machine-level (`on`), so they
 * apply from any state: `SELECT_RANGE` re-normalizes the run from the supplied
 * siblings and re-classifies; `CLEAR` returns to the caret world.
 */
export const selectionMachine = createMachine({
  context: idleContext(),
  initial: 'idle',
  states: {
    // `SELECT_RANGE` is handled in every state (enter from idle, re-select while
    // active); `CLEAR` only matters once active. Handlers live IN the states:
    // root-level `on` transitions don't apply in this v6 alpha.
    idle: {
      on: { SELECT_RANGE: ({ event }) => applyRange(event) },
    },
    single: {
      on: { SELECT_RANGE: ({ event }) => applyRange(event), CLEAR: clearToIdle },
    },
    multi: {
      on: { SELECT_RANGE: ({ event }) => applyRange(event), CLEAR: clearToIdle },
    },
  },
})
