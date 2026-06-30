import type { Node } from './schema'
import { orderSiblings } from './sibling-chain'

export type { Node } from './schema'

/**
 * In-memory index over the flat node list.
 *
 * `childrenByParent` holds each parent's children as an ordered array of **ids**
 * (not Node objects); every node read goes through `byId`, the single source of
 * truth for the live row. That shape is load-bearing for the incremental
 * maintenance in `tree-store.ts` (the Phase A scaling win — ADR 0019 / PRD
 * scale-outline): a text/field keystroke leaves the id arrays untouched, so the
 * store patches one `byId` entry in O(1) instead of rebuilding the whole index.
 * A full `buildTreeIndex` is still the snapshot/fallback path and what mutations
 * rebuild against between ops.
 */
export interface TreeIndex {
  /** parentId -> ordered child *ids*, plus the synthetic ROOT_PARENT for top-level */
  childrenByParent: Map<string, string[]>
  byId: Map<string, Node>
  /**
   * Reverse mirror index (ADR 0022): a source node's id -> ids of the *mirror*
   * nodes pointing at it (`mirrorOf === sourceId`). Built here and maintained
   * incrementally in tree-store.ts alongside `childrenByParent`. Stage 0 fills
   * it but nothing reads it yet; Stage 1 uses it for the "mirrored xN" badge,
   * Stage 3 for promote-on-delete. Empty for any mirror-free outline (every
   * `mirrorOf` is null), so it costs nothing today.
   */
  mirrorsBySource: Map<string, string[]>
}

/** Synthetic parent id for top-level nodes (those with parentId === null). */
const ROOT_PARENT = '__root__'

/** The `childrenByParent` key for a node: its parentId, or ROOT_PARENT for
 *  top-level. Exported for the incremental store maintenance in tree-store.ts. */
export function parentKeyOf(node: Node): string {
  return node.parentId ?? ROOT_PARENT
}

export function buildTreeIndex(nodes: Node[]): TreeIndex {
  const byId = new Map<string, Node>()
  const unsorted = new Map<string, Node[]>()

  for (const node of nodes) {
    byId.set(node.id, node)
    const key = parentKeyOf(node)
    const list = unsorted.get(key)
    if (list) list.push(node)
    else unsorted.set(key, [node])
  }

  // Each parent's child list is ordered by following the prevSiblingId chain;
  // orderSiblings (sibling-chain.ts) owns that walk and the orphan-append. We
  // store the ordered *ids* (node reads go through byId).
  const childrenByParent = new Map<string, string[]>()
  for (const [parentKey, list] of unsorted) {
    childrenByParent.set(parentKey, orderSiblings(list).map((n) => n.id))
  }

  // Reverse mirror index (ADR 0022): bucket each mirror's id under its source.
  // Source order within a bucket is arbitrary (callers sort if they care).
  const mirrorsBySource = new Map<string, string[]>()
  for (const node of nodes) {
    if (!node.mirrorOf) continue
    const list = mirrorsBySource.get(node.mirrorOf)
    if (list) list.push(node.id)
    else mirrorsBySource.set(node.mirrorOf, [node.id])
  }

  return { childrenByParent, byId, mirrorsBySource }
}

export function childrenOf(index: TreeIndex, parentId: string | null): Node[] {
  const ids = index.childrenByParent.get(parentId ?? ROOT_PARENT)
  if (!ids) return []
  const out: Node[] = []
  for (const id of ids) {
    const node = index.byId.get(id)
    if (node) out.push(node)
  }
  return out
}

/**
 * The mirror instances that deleting `ids` (and their subtrees) would ORPHAN: a
 * source in the deletion set whose mirror lives OUTSIDE it. Empty = safe.
 *
 * `removeNode` cascades, so the whole subtree of each id is collected, then any
 * mirror whose source is being deleted but which itself survives is an orphan.
 * Deleting a source-and-all-its-mirrors together (both in the set) is safe;
 * deleting a plain mirror is always safe (a mirror is never a source). The
 * caller blocks the delete when this is non-empty (ADR 0022: promote-on-delete
 * is Stage 3, so v1 protects rather than orphans). Mirror-free outline -> the
 * `mirrorsBySource` lookups all miss, so this is O(subtree) and returns [].
 */
export function orphanedMirrorsBy(index: TreeIndex, ids: string[]): string[] {
  const deleting = new Set<string>()
  const stack = [...ids]
  while (stack.length) {
    const id = stack.pop()!
    if (deleting.has(id)) continue
    deleting.add(id)
    for (const k of childrenOf(index, id)) stack.push(k.id)
  }
  const orphans: string[] = []
  for (const sourceId of deleting) {
    const mirrors = index.mirrorsBySource.get(sourceId)
    if (!mirrors) continue
    for (const m of mirrors) if (!deleting.has(m)) orphans.push(m)
  }
  return orphans
}

/**
 * Re-derive one parent's ordered child ids from the live `byId`: map ids ->
 * nodes, run the canonical sibling-chain order, map back to ids. Used by the
 * incremental tree-store to re-sort a parent whose membership or sibling order
 * changed (insert / reparent / reorder) — the only paths that touch the id
 * arrays. A 0/1-length list is already ordered.
 */
export function orderChildIds(byId: Map<string, Node>, ids: string[]): string[] {
  if (ids.length <= 1) return ids
  const nodes: Node[] = []
  for (const id of ids) {
    const node = byId.get(id)
    if (node) nodes.push(node)
  }
  return orderSiblings(nodes).map((n) => n.id)
}

/**
 * A node and its ancestors, from the top of the outline down to (and
 * including) `rootId` itself. Used by the zoom breadcrumb (OutlineEditor)
 * and the quick-switcher's per-result breadcrumb context (ADR 0012).
 */
export function buildTrail(index: TreeIndex, rootId: string | null): Node[] {
  if (!rootId) return []
  const trail: Node[] = []
  let current = index.byId.get(rootId) ?? null
  // Guard against corrupted parent chains.
  let guard = index.byId.size + 1
  while (current && guard-- > 0) {
    trail.unshift(current)
    current = current.parentId
      ? (index.byId.get(current.parentId) ?? null)
      : null
  }
  return trail
}

/**
 * The canonical content node for a mirror source: a mirror's own source, or the
 * node itself when it isn't a mirror. Flattens mirror-of-mirror so every created
 * mirror points at ONE true source -- there's never a chain to resolve (ADR
 * 0022). Pure -- reads `index` only.
 */
export function trueSourceOf(index: TreeIndex, sourceId: string): string {
  return index.byId.get(sourceId)?.mirrorOf ?? sourceId
}

/**
 * Whether mirroring the content node `trueSourceId` under `destParentId` would
 * form a cycle: the source is the destination itself, or an ancestor of it, so
 * the mirror would window a subtree that contains the mirror (ADR 0022). Home
 * (a null parent) never cycles. The render walk caps such a cycle if one forms
 * later (a move), but creation refuses it outright. Pure -- reads `index` only.
 */
export function wouldMirrorCycle(
  index: TreeIndex,
  trueSourceId: string,
  destParentId: string | null,
): boolean {
  let cursor: string | null = destParentId
  let guard = index.byId.size + 1
  while (cursor && guard-- > 0) {
    if (cursor === trueSourceId) return true
    cursor = index.byId.get(cursor)?.parentId ?? null
  }
  return false
}

/** Stable-ish id. crypto.randomUUID is ubiquitous in modern browsers. */
export function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function now(): number {
  return Date.now()
}

/**
 * Create a node with sensible defaults. Caller decides wiring
 * (prevSiblingId, parentId) at insert site.
 */
export function makeNode(partial: Partial<Node> & Pick<Node, 'id'>): Node {
  return {
    parentId: null,
    prevSiblingId: null,
    text: '',
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: now(),
    updatedAt: now(),
    ...partial,
  }
}
