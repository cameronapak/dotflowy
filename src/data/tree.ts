import type { Node } from './schema'

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
export const ROOT_PARENT = '__root__'

export function parentKeyOf(node: Node): string {
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

  // Each parent's child list is built by following the prevSiblingId
  // linked list starting from the head (child whose prevSiblingId is null).
  for (const [parentKey, unsorted] of childrenByParent) {
    if (unsorted.length <= 1) continue

    const byPrev = new Map<string | null, Node>()
    for (const n of unsorted) byPrev.set(n.prevSiblingId, n)

    const ordered: Node[] = []
    const idsInChain = new Set<string>()
    let cursor: string | null = null
    // Guard against cycles / corruption with an iteration cap.
    let guard = unsorted.length + 1
    while (guard-- > 0) {
      const next = byPrev.get(cursor)
      if (!next) break
      ordered.push(next)
      idsInChain.add(next.id)
      cursor = next.id
    }

    // Any nodes orphaned by a broken pointer chain get appended in
    // arrival order. Better than dropping them silently.
    for (const n of unsorted) {
      if (!idsInChain.has(n.id)) ordered.push(n)
    }

    childrenByParent.set(parentKey, ordered)
  }

  return { childrenByParent, byId }
}

export function childrenOf(index: TreeIndex, parentId: string | null): Node[] {
  return index.childrenByParent.get(parentId ?? ROOT_PARENT) ?? []
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
