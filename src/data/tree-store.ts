import { useCallback, useRef, useSyncExternalStore } from 'react'
import { nodesCollection } from './collection'
import { buildTreeIndex, childrenOf, type Node, type TreeIndex } from './tree'

/**
 * A single, app-wide subscription to the nodes collection that derives one
 * shared {@link TreeIndex} and lets components subscribe to *narrow slices* of
 * it via {@link useNode} and {@link useVisibleChildIds}.
 *
 * Why this exists: `useLiveQuery(nodesCollection)` rebuilds a brand-new `index`
 * object on every edit. Threading that object as a prop into every `OutlineNode`
 * defeats `React.memo` (a changed reference fails the shallow compare), so a
 * single keystroke re-rendered the entire visible tree -- O(visible nodes) per
 * keystroke, measured at 300 commits on a 300-node outline. See ADR 0014.
 *
 * The fix is a pull model: each `OutlineNode` reads *its own* node and child-id
 * list from this store. Because TanStack DB preserves object identity for
 * unchanged rows (an edit is an Immer draft of one row), `useNode`'s snapshot is
 * referentially stable for every node except the one that actually changed -- so
 * `useSyncExternalStore` re-renders only that node. `useVisibleChildIds` returns
 * a memoized id array that only changes identity when the *structure* (the set
 * or order of visible children) changes, never when a child's text changes.
 */

const EMPTY_INDEX: TreeIndex = buildTreeIndex([])
const EMPTY_IDS: string[] = []

let index: TreeIndex = EMPTY_INDEX
const listeners = new Set<() => void>()
let started = false

function rebuild() {
  index = buildTreeIndex(nodesCollection.toArray)
  for (const l of listeners) l()
}

/**
 * Begin the one collection subscription, lazily. `includeInitialState` makes the
 * callback fire immediately with the current rows, so the first read is already
 * populated; every later change rebuilds the shared index and notifies. Skipped
 * on the server (SPA + prerender, no localStorage) -- see ADR 0004.
 */
function ensureStarted() {
  if (started || typeof window === 'undefined') return
  started = true
  nodesCollection.subscribeChanges(() => rebuild(), { includeInitialState: true })
}

function subscribe(cb: () => void): () => void {
  ensureStarted()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The current shared index. Touching it starts the subscription on first use. */
function getTreeIndex(): TreeIndex {
  ensureStarted()
  return index
}

/** Whole-index subscription. Re-renders on every change -- use sparingly. */
export function useTreeIndex(): TreeIndex {
  return useSyncExternalStore(subscribe, getTreeIndex, () => EMPTY_INDEX)
}

/**
 * Subscribe to a single node. Re-renders only when *that* node's object changes
 * (identity is stable for unchanged rows), so an edit to one bullet never
 * re-renders its siblings.
 */
export function useNode(id: string): Node | undefined {
  const getSnapshot = useCallback(() => getTreeIndex().byId.get(id), [id])
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined)
}

/**
 * Subscribe to a node's ordered, visibility-filtered child ids. `isHidden` is
 * the composed Seam-G prune predicate (ADR 0018): the store no longer hardcodes
 * `completed` -- it hides whatever the predicate hides (hide-completed today).
 * It must be referentially stable across keystrokes (the caller memoizes it on
 * its inputs), or this cache resets every render and parents re-render on typing.
 *
 * The returned array keeps its identity until the *structure* changes (insert,
 * delete, reorder, or a prune that flips visibility) -- a child's text change
 * leaves it untouched, so the parent does not re-render on typing.
 */
export function useVisibleChildIds(
  parentId: string | null,
  isHidden: (node: Node) => boolean,
): string[] {
  // Cache the last (key, ids) so getSnapshot returns a referentially stable
  // array while the structure is unchanged. Starts null -- the first call
  // always populates, so there is no sentinel key to collide with.
  const cache = useRef<{ key: string; ids: string[] } | null>(null)
  const getSnapshot = useCallback(() => {
    const kids = childrenOf(getTreeIndex(), parentId)
    const ids: string[] = []
    for (const n of kids) if (!isHidden(n)) ids.push(n.id)
    const key = ids.join('\n')
    if (!cache.current || cache.current.key !== key) cache.current = { key, ids }
    return cache.current.ids
  }, [parentId, isHidden])
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_IDS)
}
