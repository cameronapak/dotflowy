import { useCallback, useSyncExternalStore } from 'react'
import { nodesCollection } from './collection'
import { getTreeIndex } from './tree-store'
import { getViewIsHidden, getViewRootId } from './view-state'
import { buildTreeIndex, childrenOf, type Node, type TreeIndex } from './tree'

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
 * (`rootIds`), and selecting a node implies its whole subtree (you select roots;
 * descendants come along). The fixed end is the `anchorId`; Shift+arrow moves the
 * `focusId` end. Because the run is always sibling-scoped, every operation on it
 * (copy, delete, move) has an unambiguous meaning. See ADR 0018.
 *
 * Caret and selection are mutually exclusive: while nodes are selected there is
 * no text caret. The editor enforces that (focusing any bullet clears the
 * selection); this module just holds the data.
 */

/** Where a selected ROOT sits in the slab: the first/last get rounded outer
 *  corners, the lone root rounds all four, middles round nothing. Only roots
 *  carry an edge -- a root's `<li>` background tints its whole subtree, so
 *  descendants need no per-row marker. Null means "not a selected root". */
export type SelectionEdge = 'top' | 'bottom' | 'middle' | 'single'

interface SelectionState {
  /** The shared parent of every selected root (the run is sibling-scoped). */
  parentId: string | null
  /** The fixed end of the run (where the selection started). */
  anchorId: string
  /** The moving end (Shift+arrow walks this). */
  focusId: string
  /** The selected sibling roots, in visible display order, anchor..focus
   *  inclusive. Subtrees are implied, not listed. New array identity per change
   *  (a stable snapshot for `useSyncExternalStore`). */
  rootIds: string[]
}

let state: SelectionState | null = null
let edgeByRoot = new Map<string, SelectionEdge>()
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

/** The visible siblings under `parentId`, mirroring the render's Seam-G prune
 *  (hide-completed today) so the selectable run matches what's on screen. The
 *  tag filter's separate prune is intentionally NOT applied here (v1: selecting
 *  while a tag filter is active is out of scope). */
function visibleSiblings(index: TreeIndex, parentId: string | null): Node[] {
  const isHidden = getViewIsHidden()
  return childrenOf(index, parentId).filter((n) => !isHidden(n))
}

function recomputeEdges() {
  edgeByRoot = new Map()
  if (!state) return
  const ids = state.rootIds
  if (ids.length === 1) {
    edgeByRoot.set(ids[0]!, 'single')
    return
  }
  edgeByRoot.set(ids[0]!, 'top')
  edgeByRoot.set(ids[ids.length - 1]!, 'bottom')
  for (let i = 1; i < ids.length - 1; i++) edgeByRoot.set(ids[i]!, 'middle')
}

/**
 * Set the selection to the visible sibling run between `anchorId` and `focusId`
 * (inclusive), under the anchor's parent. If the two aren't siblings (or the
 * focus has scrolled out of the visible set) the run collapses to the anchor.
 * Clears entirely if the anchor is gone.
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
  const parentId = anchor.parentId
  const sibs = visibleSiblings(index, parentId)
  const ai = sibs.findIndex((n) => n.id === anchorId)
  if (ai === -1) {
    clearSelection()
    return
  }
  let fi = sibs.findIndex((n) => n.id === focusId)
  if (fi === -1) fi = ai // focus not a visible sibling -> collapse to anchor
  const lo = Math.min(ai, fi)
  const hi = Math.max(ai, fi)
  const rootIds = sibs.slice(lo, hi + 1).map((n) => n.id)
  state = { parentId, anchorId, focusId: sibs[fi]!.id, rootIds }
  recomputeEdges()
  notify()
}

// --- public API -------------------------------------------------------------

/** Subscribe to any selection change. Module-level + referentially stable, safe
 *  as a `useSyncExternalStore` subscribe. */
export function subscribeSelection(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Whether any node selection is active. */
export function isSelectionActive(): boolean {
  return state !== null
}

/** The selected ROOT ids (subtrees implied), in visible order. Empty when no
 *  selection. Stable identity per selection -- safe as a store snapshot. */
const EMPTY_ROOTS: string[] = []
export function getSelectionRootIds(): string[] {
  return state ? state.rootIds : EMPTY_ROOTS
}

/** The full selection state, read live at event time. Null when inactive. */
export function getSelectionState(): SelectionState | null {
  return state
}

/** The slab edge for a node id, or null when it isn't a selected root. Read via
 *  {@link useSelectionEdge} in render; the live getter stays module-internal. */
function selectionEdgeOf(id: string): SelectionEdge | null {
  return edgeByRoot.get(id) ?? null
}

/** Select exactly `nodeId` and its subtree -- the fresh single-root selection
 *  used by BOTH entry paths: Cmd+A rung 2, and the first Shift+arrow press from a
 *  focused bullet. Entering deliberately selects just the node under the caret
 *  (never extends to a sibling or climbs to the parent); extension/depth-walk is
 *  for subsequent presses via {@link extendSelection}. Anchor and focus both land
 *  on it. */
export function selectSingle(nodeId: string) {
  selectRange(nodeId, nodeId)
}

/**
 * Move the focus end one visible sibling in `direction` (Shift+arrow), once a
 * selection already exists. Reversing direction shrinks back toward the anchor
 * before extending the other way -- a property of the anchor/focus model, not
 * special-cased.
 *
 * At the first/last visible sibling the run can't extend further among siblings.
 * For a MULTI-root run that edge stays a no-op -- the run never spans parents
 * (ADR 0018). For a SINGLE-root selection it instead MOVES by depth: Up selects
 * the parent, Down dives into the first visible child. The selection stays one
 * unambiguous subtree, so every operation on it is still well-defined -- this is
 * NOT the rejected visual-flatten range (which spanned parents with multiple
 * roots). Climbing stops at the zoom root (you can't select the view root or
 * escape the zoom); diving needs an expanded node with a visible child.
 */
export function extendSelection(direction: 'up' | 'down') {
  const s = state
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
    // Climb to the parent. A visible node always has a visible parent, so no
    // hidden check is needed. Stop at the zoom root (parentId === the view root,
    // or null at the top level) -- the view root isn't a selectable node.
    if (s.parentId === null || s.parentId === getViewRootId()) return
    selectSingle(s.parentId)
  } else {
    // Dive into the first visible child. Collapsed nodes render no children, so
    // there's nothing to move into.
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
  const s = state
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
 * Re-derive the selection (parentId + rootIds + edges) from the LIVE collection,
 * keeping the same anchor/focus. Call after a structural mutation that relocates
 * the selected run (indent/outdent) so the next Shift+arrow or indent reads the
 * run's NEW parent. Reads `nodesCollection` directly rather than the tree store,
 * so it's correct synchronously inside the same `runStructural` batch -- before
 * the store's subscription has rebuilt. The ids and their order are unchanged by
 * an indent/outdent, so the edges land identically; only `parentId` shifts.
 */
export function refreshSelection() {
  const s = state
  if (!s) return
  selectRange(s.anchorId, s.focusId, buildTreeIndex(nodesCollection.toArray))
}

/** Clear the selection (Escape, a click, a focus, after an op). */
export function clearSelection() {
  if (!state) return
  state = null
  edgeByRoot = new Map()
  notify()
}

/**
 * Per-node subscription to this node's slab edge, mirroring `useIsProtected`'s
 * shape: a row re-renders only when ITS edge changes (entering/leaving the
 * selection or shifting top<->middle<->bottom), never on an unrelated selection
 * change. This is what keeps multi-selection inside ADR 0014's per-node-render
 * budget. Returns null when the node isn't a selected root.
 */
export function useSelectionEdge(id: string): SelectionEdge | null {
  const getSnapshot = useCallback(() => selectionEdgeOf(id), [id])
  return useSyncExternalStore(subscribeSelection, getSnapshot, () => null)
}
