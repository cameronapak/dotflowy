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
  /**
   * The instance/position node id — where this row physically sits. Its
   * `parentId`/`prevSiblingId`, `collapsed`, and drag target are read from here.
   * Equals {@link contentId} for every normal (non-mirror) row.
   */
  id: string
  /**
   * The node to read CONTENT from — `text`, `isTask`, `completed`, and children:
   * `mirrorOf ?? id` (ADR 0022). Differs from {@link id} only on a mirror's own
   * row; everything inside a mirrored subtree is real nodes (content === id).
   */
  contentId: string
  /**
   * Unique render address: the React key, and (Stage 2) the refs/focus/flash/drag
   * key. A bare `id` until the walk crosses a mirror, then a compound path key —
   * because a source's descendant appears under every instance, so its bare id is
   * no longer unique. Equal to `id` for every mirror-free row, so the 99% outline
   * keeps today's exact identity (ADR 0022 "don't regress").
   */
  key: string
  depth: number
  ancestorCompleted: boolean
  /** This row IS a mirror (its own `mirrorOf` is set). */
  isMirror: boolean
  /**
   * A mirror whose source is already an expanded ancestor on this path: rendered
   * as a non-expandable capped row so the walk can't recurse forever (the cycle
   * net for a loop formed after creation — ADR 0022).
   */
  capped: boolean
  /** A mirror whose `mirrorOf` resolves to no node (sync race / bug): rendered as
   *  a "source not found" leaf, never expanded. */
  broken: boolean
}

/** Path-key separator: a control char that can't appear in a node id, so a joined
 *  path can't collide with another path or a bare id. */
const PATH_SEP = String.fromCharCode(1)

/**
 * Split a {@link VisibleRow.key} back into its segment node ids. A mirror-free
 * key is a single bare id, so this returns `[id]`; a key inside a mirrored
 * subtree is the `PATH_SEP`-joined instance-id chain, so this returns each hop
 * in display order. The LAST segment is always the row's own instance id
 * (ADR 0022).
 */
export function parseRowKey(key: string): string[] {
  return key.split(PATH_SEP)
}

/**
 * The row's own instance (position) node id — the last path segment. For a
 * mirror-free key this is the key itself, so `instanceIdForKey(id) === id`.
 */
export function instanceIdForKey(key: string): string {
  const i = key.lastIndexOf(PATH_SEP)
  return i === -1 ? key : key.slice(i + 1)
}

/**
 * The CONTENT node id a row key reads from: its instance id resolved through
 * `mirrorOf` (a mirror windows its source). Equals {@link VisibleRow.contentId},
 * but recomputed from a bare key for the callers that hold a key without the row
 * object (focus restore, caret nav). Falls back to the raw instance id when the
 * node is unknown. For a mirror-free row, content === instance === the key.
 */
export function contentIdForKey(index: TreeIndex, key: string): string {
  const instanceId = instanceIdForKey(key)
  return index.byId.get(instanceId)?.mirrorOf ?? instanceId
}

/**
 * Compose a child row key from its parent's path prefix and the child's instance
 * id — the inverse of {@link parseRowKey}. `prefix` is the parent row's key when
 * the child sits inside a crossed mirror; `null`/empty at the top level (the
 * child key is then its bare id, matching today's identity). Used by the
 * structural-redirect and caret-nav slices to land focus on the right instance.
 */
export function rowKeyFor(prefix: string | null, instanceId: string): string {
  return prefix ? prefix + PATH_SEP + instanceId : instanceId
}

/**
 * The parent row's key — drop the last path segment. `null` for a bare key (top
 * level / pre-mirror), matching {@link rowKeyFor}'s null prefix, so the round trip
 * holds: `rowKeyFor(parentKeyOf(childKey), instanceIdForKey(childKey)) === childKey`.
 * Used by the structural slice to compose a new sibling's key from the active row.
 */
export function parentKeyOf(key: string): string | null {
  const i = key.lastIndexOf(PATH_SEP)
  return i === -1 ? null : key.slice(0, i)
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
 * `mirrorsEnabled` (ADR 0022) turns on mirror resolution: a node with `mirrorOf`
 * windows its source's content + children, rows gain a content id + a path-based
 * key, and cycles cap / broken sources render a leaf. Default OFF, and when off
 * every branch collapses back to the original mirror-free walk (no resolution, no
 * path keys, no per-level allocation) -- the "don't regress" rule. The caret walk
 * omits it for now (mirror caret nav is Stage 2).
 *
 * Pure; no DOM, no React.
 */
export function buildVisibleRows(
  index: TreeIndex,
  rootId: string | null,
  isHidden: (n: Node) => boolean,
  filter?: TagFilter | null,
  mirrorsEnabled = false,
): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (
    // The node whose children we iterate. For a normal parent this is its own id;
    // for a mirror it is the SOURCE id (so a mirror windows the source's subtree).
    contentParentId: string | null,
    depth: number,
    ancestorCompleted: boolean,
    // The instance-id chain ANCHORED AT THE CROSSING MIRROR: empty until a mirror
    // is crossed, then the mirror's own id followed by each instance id down to
    // (not including) the current child. So a crossed row's key is
    // `mirrorId[·childId]*` and composes cleanly — `childKey === rowKeyFor(
    // parentKey, childId)` (see {@link rowKeyFor}), which the Stage 2 caret/
    // structural slices rely on. Stays `[]` in the mirror-free path.
    path: string[],
    // Has the walk descended through a mirror to reach here? Once true, rows take
    // a compound path key (their bare id is duplicated across instances).
    crossed: boolean,
    // Content ids already expanded on this path (ancestor sources). A mirror whose
    // source is in here would loop, so it caps. Only tracked under the flag.
    expandedContent: ReadonlySet<string>,
  ) => {
    for (const child of childrenOf(index, contentParentId)) {
      const mirrored = mirrorsEnabled && child.mirrorOf != null
      const contentId = mirrored ? (child.mirrorOf as string) : child.id
      const key = crossed ? path.concat(child.id).join(PATH_SEP) : child.id
      // Content node: the mirror's source, or the node itself. A non-mirror reads
      // its own row exactly as before (content === child).
      const content = mirrored ? index.byId.get(contentId) : child

      // Broken mirror: the source id resolves to nothing (sync race / bug). Render
      // a "source not found" leaf, never recurse, never throw.
      if (mirrored && !content) {
        out.push({
          id: child.id,
          contentId,
          key,
          depth,
          ancestorCompleted,
          isMirror: true,
          capped: false,
          broken: true,
        })
        continue
      }
      // content is defined here (non-mirror → child; mirror → resolved source).
      const c = content as Node
      // Visibility prunes read CONTENT (a mirror of a completed task hides under
      // hide-completed; a tag filter matches the source's text). Identical to the
      // old `isHidden(child)` / `filter.has(child.id)` when content === child.
      if (isHidden(c)) continue
      if (filter && !filter.visibleIds.has(contentId)) continue

      // Cycle net: this mirror's source is already an expanded ancestor. Cap it
      // (non-expandable; the UI shows a badge + jump-to-source) instead of looping.
      if (mirrored && expandedContent.has(contentId)) {
        out.push({
          id: child.id,
          contentId,
          key,
          depth,
          ancestorCompleted,
          isMirror: true,
          capped: true,
          broken: false,
        })
        continue
      }

      out.push({
        id: child.id,
        contentId,
        key,
        depth,
        ancestorCompleted,
        isMirror: mirrored,
        capped: false,
        broken: false,
      })

      // Faded children inherit the fade (from CONTENT's completed); filter-mode
      // descends regardless of collapse so a deep match is still reached. Collapse
      // is LOCAL -- read from the instance node (`child`), not the content.
      const childFade = ancestorCompleted || c.completed
      if (filter || !child.collapsed) {
        walk(
          contentId,
          depth + 1,
          childFade,
          // Grow the path only from the crossing mirror down (mirror-free /
          // pre-crossing levels keep it `[]`, so the key stays the bare id and
          // the 99% outline is unchanged). `crossed || mirrored` is exactly the
          // next level's `crossed`, so the path and the key grow in lockstep.
          crossed || mirrored ? path.concat(child.id) : path,
          crossed || mirrored,
          mirrorsEnabled ? new Set(expandedContent).add(contentId) : expandedContent,
        )
      }
    }
  }
  walk(rootId, 0, false, [], false, mirrorsEnabled && rootId ? new Set([rootId]) : EMPTY_EXPANDED)
  return out
}

/** Shared empty set for the mirror-free recursion (never mutated — the walk only
 *  ever copies it via `new Set(...)` under the flag). */
const EMPTY_EXPANDED: ReadonlySet<string> = new Set<string>()

/**
 * The row KEY immediately before/after `key` in visible display order within the
 * zoom root, or null if none. Used for caret motion across bullets and for
 * landing the caret above/below a node multi-selection. Takes and returns row
 * keys (the render address), so it crosses mirror boundaries correctly — a
 * windowed source descendant has a path key, not a bare id (ADR 0022). For a
 * mirror-free row key === id, so this is unchanged from before.
 *
 * `mirrorsEnabled` MUST match how the editor renders (callers pass
 * `isMirrorsEnabled()`): the neighbor sequence has to be the rendered sequence,
 * or a mirror elsewhere in the view shifts the rows and the neighbor is wrong.
 *
 * The root is prepended so ArrowUp from the first child lands on the title (the
 * root registers a contentEditable span under its own id, which is its key).
 * Filter is not applied here -- caret nav walks the unfiltered visible tree.
 */
export function findVisibleNeighbor(
  index: TreeIndex,
  rootId: string | null,
  key: string,
  direction: 'up' | 'down',
  isHidden: (n: Node) => boolean,
  mirrorsEnabled = false,
): string | null {
  const rows = buildVisibleRows(index, rootId, isHidden, null, mirrorsEnabled)
  const seq = rootId ? [rootId, ...rows.map((r) => r.key)] : rows.map((r) => r.key)
  const i = seq.indexOf(key)
  if (i === -1) return null
  const neighbor = direction === 'up' ? seq[i - 1] : seq[i + 1]
  return neighbor ?? null
}

/**
 * The render key to focus after a structural edit (insert / move) inside a mirror
 * (ADR 0022, Stage 2c). A source descendant windows into EVERY instance, so a node
 * id can address several rows; focus must land in the instance the user was
 * editing. Rather than compose the key by hand (fragile across reparent moves),
 * re-derive it from the freshly-built visible rows — the SAME render walk the UI
 * uses, so the focus key can never drift from what's on screen.
 *
 * Picks the row with `id === instanceId` whose key shares the longest leading-
 * segment prefix with `activeKey` (the pre-edit focused row): that's the copy
 * under the same crossed-mirror anchor. Ties resolve to the SHALLOWEST key (fewest
 * segments) — the copy nearest the source. Returns `null` when no visible row has
 * that id (e.g. an outdent pushed the node out of the current view). For a
 * mirror-free outline a node id is unique, so the single match is its bare key.
 * Pure.
 */
export function focusKeyAfterEdit(
  rows: readonly VisibleRow[],
  instanceId: string,
  activeKey: string,
): string | null {
  const active = parseRowKey(activeKey)
  let best: VisibleRow | null = null
  let bestShared = -1
  for (const r of rows) {
    if (r.id !== instanceId) continue
    const segs = parseRowKey(r.key)
    let shared = 0
    while (shared < segs.length && shared < active.length && segs[shared] === active[shared]) {
      shared++
    }
    if (
      shared > bestShared ||
      (shared === bestShared && best !== null && segs.length < parseRowKey(best.key).length)
    ) {
      bestShared = shared
      best = r
    }
  }
  return best?.key ?? null
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
