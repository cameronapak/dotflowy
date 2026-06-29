import { useCallback, useSyncExternalStore } from 'react'
import { createActor } from 'xstate'
import { nodesCollection } from './collection'
import { getTreeIndex } from './tree-store'
import { getViewIsHidden, getViewRootId } from './view-state'
import { buildTreeIndex, childrenOf, type Node, type TreeIndex } from './tree'
import { isSelectionMachine } from './flags'
import {
  buildEdgeMap,
  rangeFrom,
  selectionMachine,
  type SelectionEdge,
} from './selection-machine'

/**
 * Node multi-selection state (ADR 0018). A second editing mode where whole
 * *nodes* are selected (distinct from selecting text inside one bullet), so an
 * action can act on several subtrees at once.
 *
 * Shape: a module singleton mirrored like {@link view-state} and the tree store
 * -- the stable command/keyboard closures read it live at EVENT time, and each
 * row subscribes to its OWN slice via {@link useSelectionEdge}, so a selection
 * change re-renders only the rows entering or leaving it (preserving the
 * per-node-render guarantee of ADR 0014). Selection is NEVER threaded as a prop.
 *
 * Model: a selection is a **contiguous run of siblings under one parent**
 * (`rootIds`), and selecting a node implies its whole subtree. The fixed end is
 * the `anchorId`; Shift+arrow moves the `focusId` end. See ADR 0018.
 *
 * **Storage is pluggable behind the `isSelectionMachine()` flag** (the XState v6
 * PoC -- see `.scratch/xstate-effect-schema/`). Both backends share the SAME
 * tree-reading code below and the SAME `rangeFrom`/`buildEdgeMap` math, so they
 * compute identical runs -- the flag only swaps WHERE the result is held (a
 * module var vs. an Effect-Schema-typed XState actor) and how React subscribes.
 * The singleton is the default; flip localStorage to dogfood the machine.
 */

/** Where a selected ROOT sits in the slab (ADR 0018). Re-exported from the
 *  machine module, which owns the edge math shared by both backends. */
export type { SelectionEdge }

interface SelectionState {
  /** The shared parent of every selected root (the run is sibling-scoped). */
  parentId: string | null
  /** The fixed end of the run (where the selection started). */
  anchorId: string
  /** The moving end (Shift+arrow walks this). */
  focusId: string
  /** The selected sibling roots, in visible display order, anchor..focus
   *  inclusive. Subtrees are implied. New array identity per change. */
  rootIds: string[]
}

/** The visible siblings under `parentId`, mirroring the render's Seam-G prune
 *  (hide-completed today) so the selectable run matches what's on screen. */
function visibleSiblings(index: TreeIndex, parentId: string | null): Node[] {
  const isHidden = getViewIsHidden()
  return childrenOf(index, parentId).filter((n) => !isHidden(n))
}

const EMPTY_ROOTS: string[] = []

// --- pluggable backend -------------------------------------------------------

/** What a storage backend must provide. The tree-reading public functions below
 *  are backend-agnostic: they compute `{ parentId, anchor, focus, siblings }`
 *  from the live tree and hand it to `setRange`; the backend runs the (shared)
 *  range math and holds the result. */
interface SelectionBackend {
  getState(): SelectionState | null
  /** Stable identity per selection (safe as a `useSyncExternalStore` snapshot). */
  rootIds(): string[]
  edgeOf(id: string): SelectionEdge | null
  isActive(): boolean
  subscribe(cb: () => void): () => void
  setRange(input: {
    parentId: string | null
    anchorId: string
    focusId: string
    siblings: string[]
  }): void
  clear(): void
}

// --- backend 1: the module singleton (default, shipping) ---------------------

function makeSingletonBackend(): SelectionBackend {
  let state: SelectionState | null = null
  let edgeByRoot = new Map<string, SelectionEdge>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const l of listeners) l()
  }
  return {
    getState: () => state,
    rootIds: () => (state ? state.rootIds : EMPTY_ROOTS),
    edgeOf: (id) => edgeByRoot.get(id) ?? null,
    isActive: () => state !== null,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    setRange: ({ parentId, anchorId, focusId, siblings }) => {
      const r = rangeFrom(siblings, anchorId, focusId)
      if (!r) {
        if (state) {
          state = null
          edgeByRoot = new Map()
          notify()
        }
        return
      }
      state = { parentId, anchorId, focusId: r.focusId, rootIds: r.rootIds }
      edgeByRoot = buildEdgeMap(state.rootIds)
      notify()
    },
    clear: () => {
      if (!state) return
      state = null
      edgeByRoot = new Map()
      notify()
    },
  }
}

// --- backend 2: the XState v6 actor (opt-in via isSelectionMachine()) ---------

function makeMachineBackend(): SelectionBackend {
  const actor = createActor(selectionMachine).start()
  // Edge lookups are cached per selection (rebuilt only when rootIds identity
  // changes), matching the singleton's O(1)-per-row reads instead of an indexOf
  // scan on every visible row.
  let cachedRoots: readonly string[] | null = null
  let cachedEdges = new Map<string, SelectionEdge>()
  const liveRoots = (): readonly string[] => actor.getSnapshot().context.rootIds
  return {
    getState: () => {
      const c = actor.getSnapshot().context
      if (c.anchorId === null || c.focusId === null || c.rootIds.length === 0) {
        return null
      }
      // The machine context's rootIds is `readonly string[]`; callers treat the
      // selection as immutable, so the cast is sound and keeps identity stable.
      return {
        parentId: c.parentId,
        anchorId: c.anchorId,
        focusId: c.focusId,
        rootIds: c.rootIds as string[],
      }
    },
    rootIds: () => {
      const r = liveRoots()
      return r.length ? (r as string[]) : EMPTY_ROOTS
    },
    edgeOf: (id) => {
      const roots = liveRoots()
      if (roots !== cachedRoots) {
        cachedRoots = roots
        cachedEdges = buildEdgeMap(roots)
      }
      return cachedEdges.get(id) ?? null
    },
    isActive: () => !actor.getSnapshot().matches('idle'),
    subscribe: (cb) => {
      const sub = actor.subscribe(() => cb())
      return () => sub.unsubscribe()
    },
    setRange: (input) => {
      actor.send({ type: 'SELECT_RANGE', ...input })
    },
    clear: () => {
      if (actor.getSnapshot().matches('idle')) return
      actor.send({ type: 'CLEAR' })
    },
  }
}

/** The active backend is chosen ONCE at module load: the flag is a build/reload
 *  switch (like `isVirtualized`), and the two backends must not diverge mid
 *  session. SSR reads false (no window), so the actor is never created on the
 *  server. */
const backend: SelectionBackend = isSelectionMachine()
  ? makeMachineBackend()
  : makeSingletonBackend()

// --- backend-agnostic tree logic (unchanged behavior; ADR 0018) --------------

/**
 * Set the selection to the visible sibling run between `anchorId` and `focusId`
 * (inclusive), under the anchor's parent. Reads the tree, then hands the visible
 * sibling ids to the backend, which derives the run via `rangeFrom`. Clears if
 * the anchor is gone or not a visible sibling.
 */
function selectRange(
  anchorId: string,
  focusId: string,
  index: TreeIndex = getTreeIndex(),
) {
  const anchor = index.byId.get(anchorId)
  if (!anchor) {
    backend.clear()
    return
  }
  const siblings = visibleSiblings(index, anchor.parentId).map((n) => n.id)
  backend.setRange({ parentId: anchor.parentId, anchorId, focusId, siblings })
}

// --- public API -------------------------------------------------------------

/** Subscribe to any selection change. Referentially stable, safe as a
 *  `useSyncExternalStore` subscribe. */
export function subscribeSelection(cb: () => void): () => void {
  return backend.subscribe(cb)
}

/** Whether any node selection is active. */
export function isSelectionActive(): boolean {
  return backend.isActive()
}

/** The selected ROOT ids (subtrees implied), in visible order. Empty when no
 *  selection. Stable identity per selection -- safe as a store snapshot. */
export function getSelectionRootIds(): string[] {
  return backend.rootIds()
}

/** The full selection state, read live at event time. Null when inactive. */
export function getSelectionState(): SelectionState | null {
  return backend.getState()
}

/** Select exactly `nodeId` and its subtree -- the fresh single-root selection
 *  used by BOTH entry paths: Cmd+A rung 2, and the first Shift+arrow press from a
 *  focused bullet. Anchor and focus both land on it. */
export function selectSingle(nodeId: string) {
  selectRange(nodeId, nodeId)
}

/**
 * Move the focus end one visible sibling in `direction` (Shift+arrow), once a
 * selection already exists. Reversing direction shrinks back toward the anchor.
 *
 * At the first/last visible sibling a MULTI-root run can't extend further -- that
 * edge is a no-op. A SINGLE-root selection instead MOVES by depth: Up selects the
 * parent, Down dives into the first visible child (climbing stops at the zoom
 * root; diving needs an expanded node with a visible child). See ADR 0018.
 */
export function extendSelection(direction: 'up' | 'down') {
  const s = backend.getState()
  if (!s) return
  const index = getTreeIndex()
  const sibs = visibleSiblings(index, s.parentId)
  const fi = sibs.findIndex((n) => n.id === s.focusId)
  if (fi === -1) return
  const ni = direction === 'down' ? fi + 1 : fi - 1
  if (ni >= 0 && ni < sibs.length) {
    selectRange(s.anchorId, sibs[ni]!.id)
    return
  }
  // Sibling boundary. Single-root selections walk by depth; multi-root no-ops.
  if (s.rootIds.length !== 1) return
  if (direction === 'up') {
    // Climb to the parent. Stop at the zoom root (the view root isn't selectable).
    if (s.parentId === null || s.parentId === getViewRootId()) return
    selectSingle(s.parentId)
  } else {
    // Dive into the first visible child. Collapsed nodes render no children.
    const node = index.byId.get(s.focusId)
    if (!node || node.collapsed) return
    const kids = visibleSiblings(index, s.focusId)
    if (kids.length === 0) return
    selectSingle(kids[0]!.id)
  }
}

/**
 * Select every visible top-level child of the current view (Cmd+A rung 3 -- the
 * zoom root's subtree). No-op when the view is empty.
 */
export function selectAllInView() {
  const index = getTreeIndex()
  const sibs = visibleSiblings(index, getViewRootId())
  if (sibs.length === 0) return
  selectRange(sibs[0]!.id, sibs[sibs.length - 1]!.id)
}

/** Whether the current selection already covers the whole current view -- the
 *  top rung of the Cmd+A ladder, so a further Cmd+A is bounded (a no-op). */
export function isWholeViewSelected(): boolean {
  const s = backend.getState()
  if (!s) return false
  const rootId = getViewRootId()
  if (s.parentId !== rootId) return false
  const sibs = visibleSiblings(getTreeIndex(), rootId)
  return (
    sibs.length > 0 &&
    s.rootIds.length === sibs.length &&
    s.rootIds[0] === sibs[0]!.id &&
    s.rootIds[s.rootIds.length - 1] === sibs[sibs.length - 1]!.id
  )
}

/**
 * Re-derive the selection from the LIVE collection, keeping the same anchor/focus.
 * Call after a structural mutation that relocates the selected run (indent/outdent)
 * so the next Shift+arrow or indent reads the run's NEW parent. Reads
 * `nodesCollection` directly so it's correct synchronously inside the same
 * `runStructural` batch -- before the store's subscription has rebuilt.
 */
export function refreshSelection() {
  const s = backend.getState()
  if (!s) return
  selectRange(s.anchorId, s.focusId, buildTreeIndex(nodesCollection.toArray))
}

/** Clear the selection (Escape, a click, a focus, after an op). */
export function clearSelection() {
  backend.clear()
}

/**
 * Per-node subscription to this node's slab edge: a row re-renders only when ITS
 * edge changes, never on an unrelated selection change. This is what keeps
 * multi-selection inside ADR 0014's per-node-render budget. With the machine
 * backend this is the `useSelector(actor, …)` equivalent -- a
 * `useSyncExternalStore` over the actor, selecting a single per-id edge value.
 * Returns null when the node isn't a selected root.
 */
export function useSelectionEdge(id: string): SelectionEdge | null {
  const getSnapshot = useCallback(() => backend.edgeOf(id), [id])
  return useSyncExternalStore(backend.subscribe, getSnapshot, () => null)
}
