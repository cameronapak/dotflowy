import { Schema } from 'effect'
import { setup } from 'xstate'

/**
 * PROOF-OF-CONCEPT: node multi-selection (ADR 0018) modelled as an XState v6
 * machine whose context + events are typed with **Effect Schema**. This runs
 * PARALLEL to the live `selection-state.ts` singleton, behind the
 * `isSelectionMachine()` flag — it is not yet wired into the editor. See
 * `.scratch/xstate-effect-schema/` for the design + draft ADR.
 *
 * Why this file is the integration showcase:
 *
 * 1. **Effect Schema -> XState `schemas`.** `Schema.toStandardSchemaV1(s)` turns
 *    an Effect schema into a Standard-Schema-v1 object (XState v6's `schemas`
 *    accept any Standard Schema). XState infers context/event types from the
 *    type-level `~standard.types` phantom that Effect's return type carries.
 *    GOTCHA: in Effect **v4** the API is `toStandardSchemaV1` — the published
 *    v3 docs' `standardSchemaV1` does not exist here.
 *
 * 2. **Type-only today.** v6 `schemas` mostly drive *type inference*, not runtime
 *    validation (that's "where supported" / opt-in later). So this is the single
 *    source of truth for the selection *types*; it does NOT replace the real
 *    boundary validation in `worker/wire.ts`.
 *
 * 3. **Pure machine.** The tree-dependent input — which siblings are visible — is
 *    passed INTO events as a `siblings` snapshot, so the machine has no live-tree
 *    dependency and is unit-testable with `createActor` alone (the editor adapter
 *    is what reads the tree and feeds it in). The boundary depth-walk
 *    (climb-to-parent / dive-to-child at a sibling edge) is intentionally left to
 *    the adapter for the PoC.
 */

// --- Effect Schema: the single source of truth for the machine's types --------

/** The selection run, mirroring `SelectionState` in `selection-state.ts`. A
 *  transform-free Struct, so `Encoded === Type` and XState infers exactly this. */
const SelectionContextSchema = Schema.Struct({
  /** Shared parent of the run (sibling-scoped); null at the top level. */
  parentId: Schema.NullOr(Schema.String),
  /** The fixed end of the run; null only when idle. */
  anchorId: Schema.NullOr(Schema.String),
  /** The moving end (EXTEND walks this); null only when idle. */
  focusId: Schema.NullOr(Schema.String),
  /** Selected sibling roots in visible order, anchor..focus inclusive. */
  rootIds: Schema.Array(Schema.String),
})

/** The decoded context type, derived from the schema (never hand-written). */
export type SelectionContext = Schema.Schema.Type<typeof SelectionContextSchema>

/** Enter selection on exactly `nodeId` (Cmd+A rung 2 / first Shift+arrow). */
const SelectSingleEvent = Schema.Struct({
  nodeId: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  /** Visible sibling ids under `parentId`, in display order (tree snapshot). */
  siblings: Schema.Array(Schema.String),
})

/** Move the focus end one visible sibling (Shift+arrow), once active. */
const ExtendEvent = Schema.Struct({
  dir: Schema.Literals(['up', 'down']),
  siblings: Schema.Array(Schema.String),
})

/** Select the whole visible run under `parentId` (Cmd+A rung 3). */
const SelectAllEvent = Schema.Struct({
  parentId: Schema.NullOr(Schema.String),
  siblings: Schema.Array(Schema.String),
})

/** Local alias for the v4 bridge — see the GOTCHA in the file header. */
const std = Schema.toStandardSchemaV1

// --- pure range math (no tree, no XState) ------------------------------------

/** The inclusive sibling run between `anchorId` and `focusId` within `siblings`,
 *  collapsing to the anchor if focus isn't a visible sibling. Null if the anchor
 *  itself is gone. Mirrors `selectRange` in `selection-state.ts`, minus the tree
 *  read (siblings are passed in). */
function rangeFrom(
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

/** A fresh idle context (never share the reference across transitions). */
function idleContext(): SelectionContext {
  return { parentId: null, anchorId: null, focusId: null, rootIds: [] }
}

// --- the machine -------------------------------------------------------------

const { createMachine } = setup({
  schemas: {
    context: std(SelectionContextSchema),
    events: {
      SELECT_SINGLE: std(SelectSingleEvent),
      EXTEND: std(ExtendEvent),
      SELECT_ALL: std(SelectAllEvent),
      CLEAR: std(Schema.Struct({})),
    },
  },
})

/**
 * `idle → single → multi`. Caret and selection are mutually exclusive (ADR 0018);
 * `idle` is the caret world. `SELECT_SINGLE` / `SELECT_ALL` enter from anywhere;
 * `EXTEND` only matters while active; `CLEAR` returns to caret.
 */
export const selectionMachine = createMachine({
  context: idleContext(),
  initial: 'idle',
  states: {
    idle: {
      on: {
        SELECT_SINGLE: ({ event }) => ({
          target: 'single',
          context: {
            parentId: event.parentId,
            anchorId: event.nodeId,
            focusId: event.nodeId,
            rootIds: [event.nodeId],
          },
        }),
        SELECT_ALL: ({ event }) => {
          if (event.siblings.length === 0) return undefined
          return {
            target: event.siblings.length === 1 ? 'single' : 'multi',
            context: {
              parentId: event.parentId,
              anchorId: event.siblings[0]!,
              focusId: event.siblings[event.siblings.length - 1]!,
              rootIds: [...event.siblings],
            },
          }
        },
      },
    },
    single: {
      on: {
        SELECT_SINGLE: ({ event }) => ({
          target: 'single',
          context: {
            parentId: event.parentId,
            anchorId: event.nodeId,
            focusId: event.nodeId,
            rootIds: [event.nodeId],
          },
        }),
        EXTEND: ({ context, event }) => extend(context, event.dir, event.siblings),
        SELECT_ALL: ({ event }) => {
          if (event.siblings.length === 0) return undefined
          return {
            target: event.siblings.length === 1 ? 'single' : 'multi',
            context: {
              parentId: event.parentId,
              anchorId: event.siblings[0]!,
              focusId: event.siblings[event.siblings.length - 1]!,
              rootIds: [...event.siblings],
            },
          }
        },
        CLEAR: () => ({ target: 'idle', context: idleContext() }),
      },
    },
    multi: {
      on: {
        SELECT_SINGLE: ({ event }) => ({
          target: 'single',
          context: {
            parentId: event.parentId,
            anchorId: event.nodeId,
            focusId: event.nodeId,
            rootIds: [event.nodeId],
          },
        }),
        EXTEND: ({ context, event }) => extend(context, event.dir, event.siblings),
        SELECT_ALL: ({ event }) => {
          if (event.siblings.length === 0) return undefined
          return {
            target: event.siblings.length === 1 ? 'single' : 'multi',
            context: {
              parentId: event.parentId,
              anchorId: event.siblings[0]!,
              focusId: event.siblings[event.siblings.length - 1]!,
              rootIds: [...event.siblings],
            },
          }
        },
        CLEAR: () => ({ target: 'idle', context: idleContext() }),
      },
    },
  },
})

/** Shared EXTEND transition body: walk the focus end one visible sibling, picking
 *  `single`/`multi` from the resulting run length. A sibling-boundary step is a
 *  no-op here (the parent/child depth-walk lives in the adapter for the PoC). */
function extend(
  context: SelectionContext,
  dir: 'up' | 'down',
  siblings: readonly string[],
): { target: 'single' | 'multi'; context: SelectionContext } | undefined {
  if (context.anchorId === null || context.focusId === null) return undefined
  const fi = siblings.indexOf(context.focusId)
  if (fi === -1) return undefined
  const ni = dir === 'down' ? fi + 1 : fi - 1
  if (ni < 0 || ni >= siblings.length) return undefined
  const r = rangeFrom(siblings, context.anchorId, siblings[ni]!)
  if (!r) return undefined
  return {
    target: r.rootIds.length === 1 ? 'single' : 'multi',
    context: { ...context, focusId: r.focusId, rootIds: r.rootIds },
  }
}
