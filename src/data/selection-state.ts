import { useSelector } from '@xstate/react'
import { createActor } from 'xstate'
import { nodesCollection } from './collection'
import { getTreeIndex } from './tree-store'
import { getViewIsHidden, getViewRootId } from './view-state'
import { buildTreeIndex, childrenOf, type Node, type TreeIndex } from './tree'
import {
  buildEdgeMap,
  selectionMachine,
  type SelectionEdge,
} from './selection-machine'

/**
 * Node multi-selection state (ADR 0018). A second editing mode where whole
 * *nodes* are selected (distinct from selecting text inside one bullet), so an
 * action can act on several subtrees at once.
 *
 * Storage is a single module-singleton **XState v6 actor** whose context +
 * events are typed with **Effect Schema** (`selection-machine.ts`). The
 * stable command/keyboard closures read it live at EVENT time, and each row
 * subscribes to its OWN slice via {@link useSelectionEdge} (`useSelector`), so a
 * selection change re-renders only the rows entering or leaving it (preserving
 * the per-node-render guarantee of ADR 0014). Selection is NEVER threaded as a
 * prop.
 *
 * Model: a selection is a **contiguous run of siblings under one parent**
 * (`rootIds`), and selecting a node implies its whole subtree. The fixed end is
 * the `anchorId`; Shift+arrow moves the `focusId` end. See ADR 0018.
 *
 * The tree-reading functions below stay machine-agnostic: they read the live
 * tree, hand the visible sibling ids to the actor, and the machine normalizes
 * the run via `rangeFrom` and classifies `idle/single/multi`. The machine is
 * pure (tree facts arrive as event data), so the adapter owns every tree read.
 */

/** Where a selected ROOT sits in the slab (ADR 0018). Re-exported from the
 *  machine module, which owns the edge math. */
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

// --- the selection actor (module singleton) ---------------------------------

/** The selection lives in one XState actor for the app's lifetime. Creation is
 *  pure (no DOM/tree reads until an event arrives), so it is SSR-safe: the
 *  prerender sees an idle selection and `useSelector` reads that same snapshot
 *  as its server value. */
const selectionActor = createActor(selectionMachine).start()

/** The live selection as a {@link SelectionState}, or null when idle. Built
 *  fresh per call; read imperatively at event time, never as a store snapshot. */
function selectionState(): SelectionState | null {
  const c = selectionActor.getSnapshot().context
  if (c.anchorId === null || c.focusId === null || c.rootIds.length === 0) {
    return null
  }
  // The machine context's rootIds is `readonly string[]`; callers treat the
  // selection as immutable, so widening the cast is sound and keeps identity
  // stable across reads.
  return {
    parentId: c.parentId,
    anchorId: c.anchorId,
    focusId: c.focusId,
    rootIds: c.rootIds as string[],
  }
}

/** Per-selection edge map, rebuilt only when the run's identity changes, so a
 *  per-row {@link useSelectionEdge} read stays O(1) instead of an indexOf scan
 *  on every visible row. The machine hands out a fresh `rootIds` array per
 *  transition, so identity equality is a safe cache key. */
let edgeCacheRoots: readonly string[] | null = null
let edgeCache = new Map<string, SelectionEdge>()
function edgeOf(rootIds: readonly string[], id: string): SelectionEdge | null {
  if (rootIds !== edgeCacheRoots) {
    edgeCacheRoots = rootIds
    edgeCache = buildEdgeMap(rootIds)
  }
  return edgeCache.get(id) ?? null
}

// --- tree logic (ADR 0018) --------------------------------------------------

/**
 * Set the selection to the visible sibling run between `anchorId` and `focusId`
 * (inclusive), under the anchor's parent. Reads the tree, then hands the visible
 * sibling ids to the actor, which derives the run via `rangeFrom`. Clears if
 * the anchor is gone or not a visible sibling.
 */
function selectRange(
  anchorId: string,
  focusId: string,
  index: TreeIndex = getTreeIndex(),
) {
  const anchor = index.byId.get(anchorId)
  if (!anchor) {
    clearSelection()
    return
  }
  const siblings = visibleSiblings(index, anchor.parentId).map((n) => n.id)
  selectionActor.send({
    type: 'SELECT_RANGE',
    parentId: anchor.parentId,
    anchorId,
    focusId,
    siblings,
  })
}

// --- public API -------------------------------------------------------------

/** Subscribe to any selection change. Referentially stable, safe as a
 *  `useSyncExternalStore` subscribe. */
export function subscribeSelection(cb: () => void): () => void {
  const sub = selectionActor.subscribe(cb)
  return () => sub.unsubscribe()
}

/** Whether any node selection is active. */
export function isSelectionActive(): boolean {
  return !selectionActor.getSnapshot().matches('idle')
}

/** The selected ROOT ids (subtrees implied), in visible order. Empty when no
 *  selection. Stable identity per selection -- safe as a store snapshot. */
export function getSelectionRootIds(): string[] {
  const r = selectionActor.getSnapshot().context.rootIds
  return r.length ? (r as string[]) : EMPTY_ROOTS
}

/** The full selection state, read live at event time. Null when inactive. */
export function getSelectionState(): SelectionState | null {
  return selectionState()
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
  const s = selectionState()
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
  const s = selectionState()
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
  const s = selectionState()
  if (!s) return
  selectRange(s.anchorId, s.focusId, buildTreeIndex(nodesCollection.toArray))
}

/** Clear the selection (Escape, a click, a focus, after an op). */
export function clearSelection() {
  if (selectionActor.getSnapshot().matches('idle')) return
  selectionActor.send({ type: 'CLEAR' })
}

/**
 * Per-node subscription to this node's slab edge: a row re-renders only when ITS
 * edge changes, never on an unrelated selection change. This is what keeps
 * multi-selection inside ADR 0014's per-node-render budget. `useSelector` is a
 * `useSyncExternalStore`-with-selector over the actor, returning a single per-id
 * edge value compared with `Object.is`. Returns null when the node isn't a
 * selected root.
 */
export function useSelectionEdge(id: string): SelectionEdge | null {
  return useSelector(selectionActor, (snap) => edgeOf(snap.context.rootIds, id))
}
