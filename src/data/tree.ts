import type { Node } from './schema'
import { orderSiblings } from './sibling-chain'

export type { Node } from './schema'

/**
 * In-memory index built from the flat node list.
 * Re-derived on every render from useLiveQuery output. For a personal
 * outline this is cheap (hundreds to low thousands of nodes); if it ever
 * gets slow, memoize per-parent.
 */
export interface TreeIndex {
  /** parentId -> ordered children, plus the synthetic ROOT_PARENT for top-level */
  childrenByParent: Map<string, Node[]>
  byId: Map<string, Node>
}

/** Synthetic parent id for top-level nodes (those with parentId === null). */
const ROOT_PARENT = '__root__'

function parentKeyOf(node: Node): string {
  return node.parentId ?? ROOT_PARENT
}

export function buildTreeIndex(nodes: Node[]): TreeIndex {
  const byId = new Map<string, Node>()
  const childrenByParent = new Map<string, Node[]>()

  for (const node of nodes) {
    byId.set(node.id, node)
    const key = parentKeyOf(node)
    const list = childrenByParent.get(key)
    if (list) list.push(node)
    else childrenByParent.set(key, [node])
  }

  // Each parent's child list is ordered by following the prevSiblingId chain;
  // orderSiblings (sibling-chain.ts) owns that walk and the orphan-append.
  for (const [parentKey, unsorted] of childrenByParent) {
    childrenByParent.set(parentKey, orderSiblings(unsorted))
  }

  return { childrenByParent, byId }
}

export function childrenOf(index: TreeIndex, parentId: string | null): Node[] {
  return index.childrenByParent.get(parentId ?? ROOT_PARENT) ?? []
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
