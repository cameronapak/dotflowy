import { childrenOf, type Node, type TreeIndex } from './tree'
import type { TagFilter } from './tags'

/**
 * One visible row of the outline, in display order, as the windowed renderer and
 * the caret-neighbor walk both consume it (ADR 0019). `depth` is relative to the
 * zoom root (a direct child of the root is depth 0), driving the row's visual
 * indentation now that nesting is no longer DOM structure. `ancestorCompleted`
 * is the fade-inheritance bit carried DOWN the walk -- true when any ancestor
 * *within the current view* is completed -- so a flat row knows to render faded
 * without a parent passing it a prop (ADR 0002).
 */
export interface VisibleRow {
  id: string
  depth: number
  ancestorCompleted: boolean
}

/**
 * The visible (non-collapsed, non-hidden) descendants of `rootId` in display
 * order, flattened to a depth-tagged list. EXCLUDES the root itself: when zoomed
 * the root renders as the page title (not a list row), and at the top level
 * (`rootId === null`) there is no root. The caret walk re-adds the root at the
 * front (see {@link findVisibleNeighbor}).
 *
 * `isHidden` is the composed Seam-G prune (hide-completed today), so this MIRRORS
 * what the editor renders -- a node absent from the DOM is absent here too.
 *
 * `filter` (the tags plugin's pruned set, ADR 0015) switches the walk to
 * filter-mode: collapse state is IGNORED (matches inside a closed subtree are
 * revealed) and only nodes in `filter.visibleIds` survive -- exactly the
 * recursive render's per-node filter. Omitted by the caret walk (nav doesn't
 * prune to the filter), so render and nav share one builder, parameterized.
 *
 * Pure; no DOM, no React.
 */
export function buildVisibleRows(
  index: TreeIndex,
  rootId: string | null,
  isHidden: (n: Node) => boolean,
  filter?: TagFilter | null,
): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (
    parentId: string | null,
    depth: number,
    ancestorCompleted: boolean,
  ) => {
    for (const child of childrenOf(index, parentId)) {
      if (isHidden(child)) continue
      if (filter && !filter.visibleIds.has(child.id)) continue
      out.push({ id: child.id, depth, ancestorCompleted })
      // Faded children inherit the fade; filter-mode descends regardless of
      // collapse so a deep match is still reached.
      const childFade = ancestorCompleted || child.completed
      if (filter || !child.collapsed) walk(child.id, depth + 1, childFade)
    }
  }
  walk(rootId, 0, false)
  return out
}

/**
 * The id immediately before/after `id` in visible display order within the zoom
 * root, or null if none. Used for caret motion across bullets and for landing
 * the caret above/below a node multi-selection.
 *
 * The root is prepended so ArrowUp from the first child lands on the title (the
 * root registers a contentEditable span under its own id). Filter is not applied
 * here -- caret nav walks the unfiltered visible tree, unchanged from before.
 */
export function findVisibleNeighbor(
  index: TreeIndex,
  rootId: string | null,
  id: string,
  direction: 'up' | 'down',
  isHidden: (n: Node) => boolean,
): string | null {
  const rows = buildVisibleRows(index, rootId, isHidden)
  const seq = rootId ? [rootId, ...rows.map((r) => r.id)] : rows.map((r) => r.id)
  const i = seq.indexOf(id)
  if (i === -1) return null
  const neighbor = direction === 'up' ? seq[i - 1] : seq[i + 1]
  return neighbor ?? null
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
