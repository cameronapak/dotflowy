import { useCallback, useRef, useSyncExternalStore } from 'react'
import { RowChangeKind, type SubscriptionDelta } from 'jazz-tools'
import { app, type Node } from './schema'
import { whenDbReady } from './jazz'
import { buildTreeIndex, childrenOf, type TreeIndex } from './tree'

/**
 * A single, app-wide subscription to the nodes table that derives one shared
 * {@link TreeIndex} and lets components subscribe to *narrow slices* of it via
 * {@link useNode} and {@link useVisibleChildIds}.
 *
 * Why this exists: a whole-tree subscription rebuilds a brand-new `index` on
 * every edit. Threading that object as a prop into every `OutlineNode` defeats
 * `React.memo` (a changed reference fails the shallow compare), so a single
 * keystroke re-rendered the entire visible tree. See ADR 0014.
 *
 * The fix is a pull model: each `OutlineNode` reads *its own* node and child-id
 * list from this store. Identity stability is what makes that work, so it is
 * preserved deliberately here: Jazz's `subscribeAll` hands back a freshly
 * allocated array of fresh row objects on every delta, so we apply the delta's
 * row-change stream to a persistent `byId` map and keep the *old* object
 * reference for any row that did not change. `useNode`'s snapshot is then
 * referentially stable for every node except the one that actually changed --
 * so `useSyncExternalStore` re-renders only that node.
 */

const EMPTY_INDEX: TreeIndex = buildTreeIndex([])
const EMPTY_IDS: string[] = []

let index: TreeIndex = EMPTY_INDEX
/** Identity-stable node objects, keyed by id. Survives across deltas. */
let stableById = new Map<string, Node>()
const listeners = new Set<() => void>()
let started = false
let unsubscribe: (() => void) | null = null

function rebuild() {
  index = buildTreeIndex(Array.from(stableById.values()))
  for (const l of listeners) l()
}

/**
 * Fold one subscription delta into {@link stableById}, preserving object
 * identity for unchanged rows. `delta.all` is the full current result set (all
 * new references); `delta.delta` tells us which ids were added/updated, so every
 * other row keeps the reference it already had.
 */
function applyDelta(delta: SubscriptionDelta<Node>) {
  const changed = new Set<string>()
  for (const d of delta.delta) {
    if (d.kind === RowChangeKind.Added || d.kind === RowChangeKind.Updated) {
      changed.add(d.id)
    }
  }
  const next = new Map<string, Node>()
  for (const row of delta.all) {
    const prev = stableById.get(row.id)
    next.set(row.id, prev && !changed.has(row.id) ? prev : row)
  }
  stableById = next
  rebuild()
}

/**
 * Begin the one table subscription, lazily and browser-only. Waits for the Jazz
 * runtime to load, then `subscribeAll` fires immediately with the current rows
 * (as an all-Added delta) and on every later change. Skipped on the server
 * (SPA + prerender, no OPFS/Worker) -- see ADR 0004.
 */
function ensureStarted() {
  if (started || typeof window === 'undefined') return
  started = true
  void whenDbReady().then((db) => {
    unsubscribe = db.subscribeAll(app.nodes, (delta) =>
      applyDelta(delta as SubscriptionDelta<Node>),
    )
  })
}

function subscribe(cb: () => void): () => void {
  ensureStarted()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The current shared index. Touching it starts the subscription on first use. */
export function getTreeIndex(): TreeIndex {
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
 * Subscribe to a node's ordered, visibility-filtered child ids. The returned
 * array keeps its identity until the *structure* changes (insert, delete,
 * reorder, or a completion toggle that flips visibility) -- a child's text
 * change leaves it untouched, so the parent does not re-render on typing.
 */
export function useVisibleChildIds(
  parentId: string | null,
  showCompleted: boolean,
): string[] {
  // Cache the last (key, ids) so getSnapshot returns a referentially stable
  // array while the structure is unchanged. Starts null -- the first call
  // always populates, so there is no sentinel key to collide with.
  const cache = useRef<{ key: string; ids: string[] } | null>(null)
  const getSnapshot = useCallback(() => {
    const kids = childrenOf(getTreeIndex(), parentId)
    const ids: string[] = []
    for (const n of kids) if (showCompleted || !n.completed) ids.push(n.id)
    const key = ids.join('\n')
    if (!cache.current || cache.current.key !== key) cache.current = { key, ids }
    return cache.current.ids
  }, [parentId, showCompleted])
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_IDS)
}
