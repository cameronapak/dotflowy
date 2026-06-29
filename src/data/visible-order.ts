import { childrenOf, type Node, type TreeIndex } from './tree'

/**
 * The visible (non-collapsed, non-hidden) outline in display order within the
 * current zoom root. `isHidden` is the composed Seam-G prune (hide-completed
 * today), so this MIRRORS what the editor actually renders -- a node absent from
 * the DOM is absent here too. The zoom root (the title) is the first entry, so
 * ArrowUp from the first child lands on the title.
 *
 * Shared by the caret-neighbor walk ({@link findVisibleNeighbor}, used by
 * onMoveFocus/delete-focus) and node multi-selection (which mirrors the same
 * visible order to pick the row above/below a selection). Extracted from
 * OutlineEditor so both read one definition. Pure; no DOM, no React.
 */
function flattenVisible(
  index: TreeIndex,
  rootId: string | null,
  isHidden: (n: Node) => boolean,
): Array<{ id: string }> {
  const out: Array<{ id: string }> = []
  if (rootId) out.push({ id: rootId })
  const walk = (parentId: string | null) => {
    for (const child of childrenOf(index, parentId)) {
      if (isHidden(child)) continue
      out.push({ id: child.id })
      if (!child.collapsed) walk(child.id)
    }
  }
  walk(rootId)
  return out
}

/**
 * The id immediately before/after `id` in visible display order within the zoom
 * root, or null if none. Used for caret motion across bullets and for landing
 * the caret above/below a node multi-selection.
 */
export function findVisibleNeighbor(
  index: TreeIndex,
  rootId: string | null,
  id: string,
  direction: 'up' | 'down',
  isHidden: (n: Node) => boolean,
): string | null {
  const flat = flattenVisible(index, rootId, isHidden)
  const i = flat.findIndex((n) => n.id === id)
  if (i === -1) return null
  const neighbor = direction === 'up' ? flat[i - 1] : flat[i + 1]
  return neighbor ? neighbor.id : null
}

/**
 * The last visible row inside `id`'s own subtree, walking down the last visible
 * child at each level until a leaf (or a collapsed node, whose hidden children
 * don't render). Returns `id` itself when it has no visible descendants. This is
 * the BOTTOM row of a selected subtree -- the anchor for "drop the caret below
 * the selection" (the row just after the deepest-last descendant), which is not
 * the same as the row after the subtree's root.
 */
export function lastVisibleDescendant(
  index: TreeIndex,
  id: string,
  isHidden: (n: Node) => boolean,
): string {
  let last = id
  let node = index.byId.get(id)
  let guard = index.byId.size + 1
  while (node && !node.collapsed && guard-- > 0) {
    const kids = childrenOf(index, node.id).filter((n) => !isHidden(n))
    if (kids.length === 0) break
    last = kids[kids.length - 1]!.id
    node = index.byId.get(last)
  }
  return last
}
