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

  return { childrenByParent, byId }
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
    createdAt: now(),
    updatedAt: now(),
    ...partial,
  }
}
