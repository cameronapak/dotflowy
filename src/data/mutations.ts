import { nodesCollection } from './collection'
import {
  type Node,
  type TreeIndex,
  buildTreeIndex,
  childrenOf,
  createId,
  makeNode,
  now,
} from './tree'

/**
 * All mutations operate on the nodesCollection directly (LocalStorage
 * collections are mutated imperatively; persistence is automatic).
 *
 * Every function takes the current TreeIndex so it can find siblings /
 * ordering without re-deriving it. The caller (OutlineEditor) holds the
 * live-derived index.
 */

function update(nodeId: string, patch: Partial<Node>) {
  nodesCollection.update(nodeId, (draft) => {
    Object.assign(draft, patch, { updatedAt: now() })
  })
}

/**
 * Insert a fresh empty node as the next sibling of `afterId`, or as the
 * new last child of `parentId` when afterId is null.
 *
 * `isTask` lets the caller carry the node type forward so pressing Enter at
 * the end of a task creates another task (not a plain bullet).
 *
 * `text` seeds the new node's text -- used by the Enter-mid-bullet split, where
 * everything right of the caret moves into this new sibling.
 *
 * Returns the new node's id so the editor can focus it.
 */
export function insertSibling(
  index: TreeIndex,
  parentId: string | null,
  afterId: string | null,
  isTask = false,
  text = '',
): string {
  const id = createId()
  const prevSiblingId = afterId

  // The node currently following `afterId` becomes the new node's follower.
  let nextSiblingId: string | null = null
  if (afterId) {
    const siblings = childrenOf(index, parentId)
    const i = siblings.findIndex((n) => n.id === afterId)
    if (i !== -1 && i + 1 < siblings.length) {
      nextSiblingId = siblings[i + 1]!.id
    }
  }

  nodesCollection.insert(
    makeNode({ id, parentId, prevSiblingId, text, isTask }),
  )

  // Repoint the follower at the new node.
  if (nextSiblingId) {
    update(nextSiblingId, { prevSiblingId: id })
  }

  return id
}

/**
 * Insert a fresh empty node as the FIRST child of `parentId`, pushing the
 * current head (if any) down. Used when pressing Enter on a zoomed node's
 * title: the new bullet should appear directly under the title.
 *
 * `id` lets a caller supply the node id up front (the daily plugin mints it
 * before an atomic claim, so the winner inserts the node under the id the claim
 * settled on). Defaults to a fresh id.
 *
 * Returns the new node's id so the editor can focus it.
 */
export function insertChildAtStart(
  index: TreeIndex,
  parentId: string | null,
  isTask = false,
  text = '',
  id = createId(),
): string {
  const head = childrenOf(index, parentId)[0] ?? null

  nodesCollection.insert(
    makeNode({ id, parentId, prevSiblingId: null, text, isTask }),
  )

  // The old head now follows the new node.
  if (head) update(head.id, { prevSiblingId: id })

  return id
}

/**
 * Append a node at the end of `parentId`'s children. Used by the
 * first-run seed, where we don't have a live TreeIndex in scope and the
 * caller knows the parent is empty or has a known last child.
 *
 * Pass `prevSiblingId` explicitly so seed code owns the wiring. `id` lets a
 * caller supply the node id up front (the daily plugin's claimed container id);
 * defaults to a fresh id.
 */
export function appendChild(
  parentId: string | null,
  prevSiblingId: string | null = null,
  text = '',
  id = createId(),
): string {
  nodesCollection.insert(
    makeNode({ id, parentId, prevSiblingId, text }),
  )
  return id
}

/**
 * Indent: move `nodeId` to become the last child of its previous sibling.
 * No-op if it's already the first child of its parent.
 *
 * Returns true if a move happened.
 *
 * Effect on siblings:
 *  - node's old next sibling's prevSiblingId becomes node's old prevSiblingId
 *  - node's prevSiblingId becomes the previous sibling's id (now its parent)
 */
export function indent(index: TreeIndex, nodeId: string): boolean {
  const node = index.byId.get(nodeId)
  if (!node || !node.prevSiblingId) return false

  const newParent = index.byId.get(node.prevSiblingId)
  if (!newParent) return false

  const oldParent = node.parentId
  const oldSiblings = childrenOf(index, oldParent)
  const i = oldSiblings.findIndex((n) => n.id === nodeId)
  const oldNext = i !== -1 && i + 1 < oldSiblings.length
    ? oldSiblings[i + 1]!
    : null

  // Node becomes last child of newParent. If that parent was collapsed, the
  // node would be indented out of sight, so expand it to keep the node visible.
  update(nodeId, { parentId: newParent.id, prevSiblingId: null })
  if (newParent.collapsed) update(newParent.id, { collapsed: false })

  // Old next sibling links back to node's old prev.
  if (oldNext) {
    update(oldNext.id, { prevSiblingId: node.prevSiblingId })
  }

  // Node is now the last child of newParent; repoint whatever was last.
  const newSiblings = childrenOf(index, newParent.id)
  // newSiblings is from the pre-mutation index, so it doesn't include node yet.
  if (newSiblings.length > 0) {
    const lastExisting = newSiblings[newSiblings.length - 1]!
    update(nodeId, { prevSiblingId: lastExisting.id })
  }

  return true
}

/**
 * Outdent: move `nodeId` up one level. It becomes the sibling immediately
 * after its former parent.
 *
 * No-op if the node is already top-level (parentId === null).
 *
 * Effect:
 *  - node's parent becomes its grandparent
 *  - node's prevSiblingId becomes its old parent's id
 *  - node's old next sibling (under old parent) repoints to node's old prevSiblingId
 *  - the node that used to follow the old parent now repoints to node
 */
export function outdent(index: TreeIndex, nodeId: string): boolean {
  const node = index.byId.get(nodeId)
  if (!node || node.parentId === null) return false

  const oldParent = index.byId.get(node.parentId)
  if (!oldParent) return false

  const newParentId = oldParent.parentId

  // Siblings under old parent.
  const oldSiblings = childrenOf(index, oldParent.id)
  const i = oldSiblings.findIndex((n) => n.id === nodeId)
  const oldNext = i !== -1 && i + 1 < oldSiblings.length
    ? oldSiblings[i + 1]!
    : null

  // Siblings under new parent (i.e. old parent's level), used to find the
  // node that currently follows oldParent so we can splice node in between.
  const newSiblings = childrenOf(index, newParentId)
  const parentIdx = newSiblings.findIndex((n) => n.id === oldParent.id)
  const afterParent = parentIdx !== -1 && parentIdx + 1 < newSiblings.length
    ? newSiblings[parentIdx + 1]!
    : null

  // Move node up.
  update(nodeId, {
    parentId: newParentId,
    prevSiblingId: oldParent.id,
  })

  // Old next sibling (under old parent) relinks to node's old prev.
  if (oldNext) {
    update(oldNext.id, { prevSiblingId: node.prevSiblingId })
  }

  // The node that followed oldParent now follows node.
  if (afterParent) {
    update(afterParent.id, { prevSiblingId: nodeId })
  }

  return true
}

interface MoveOpts {
  /**
   * Show-completed predicate. A move targets the nearest *visible* sibling,
   * skipping hidden completed ones (they ride along, staying hidden), so a
   * press is never a dead no-visible-change move. Defaults to "all visible".
   */
  isVisible?: (n: Node) => boolean
  /**
   * Boundary parent (the zoom root). A node directly under it must not escape
   * the visible subtree, so an edge move there is a no-op. See ADR 0009.
   */
  rootId?: string | null
}

/**
 * Edge helper for move-up: reparent into the parent's previous sibling as its
 * last child (Workflowy-style "nudge up" into the uncle subtree).
 */
function reparentIntoParentPrevSibling(
  index: TreeIndex,
  node: Node,
  rootId: string | null,
): boolean {
  if (node.parentId === null || node.parentId === rootId) return false
  const parent = index.byId.get(node.parentId)
  if (!parent?.prevSiblingId) return false

  const uncleId = parent.prevSiblingId
  const uncleChildren = childrenOf(index, uncleId)
  const afterSiblingId =
    uncleChildren.length > 0 ? uncleChildren[uncleChildren.length - 1]!.id : null

  const uncle = index.byId.get(uncleId)
  if (uncle?.collapsed) update(uncle.id, { collapsed: false })

  return moveNode(index, node.id, uncleId, afterSiblingId)
}

/**
 * Edge helper for move-down: reparent into the parent's next sibling as its
 * first child (Workflowy-style "nudge down" into the aunt subtree).
 */
function reparentIntoParentNextSibling(
  index: TreeIndex,
  node: Node,
  rootId: string | null,
): boolean {
  if (node.parentId === null || node.parentId === rootId) return false
  const parent = index.byId.get(node.parentId)
  if (!parent) return false

  const parentSiblings = childrenOf(index, parent.parentId)
  const pi = parentSiblings.findIndex((n) => n.id === parent.id)
  const aunt =
    pi !== -1 && pi + 1 < parentSiblings.length ? parentSiblings[pi + 1]! : null
  if (!aunt) return false

  if (aunt.collapsed) update(aunt.id, { collapsed: false })

  return moveNode(index, node.id, aunt.id, null)
}

/**
 * Move `nodeId` up among its siblings. If a visible sibling sits above it,
 * swap with that sibling (same depth, subtree carried). Otherwise (it is the
 * first visible child) reparent into the parent's previous sibling as its last
 * child.
 *
 * Returns true if a move happened. See ADR 0009.
 */
export function moveUp(
  index: TreeIndex,
  nodeId: string,
  opts: MoveOpts = {},
): boolean {
  const isVisible = opts.isVisible ?? (() => true)
  const node = index.byId.get(nodeId)
  if (!node) return false

  const siblings = childrenOf(index, node.parentId)
  const i = siblings.findIndex((n) => n.id === nodeId)
  if (i === -1) return false

  // Nearest visible sibling above, skipping hidden completed ones.
  let vp: Node | null = null
  for (let j = i - 1; j >= 0; j--) {
    if (isVisible(siblings[j]!)) {
      vp = siblings[j]!
      break
    }
  }

  if (!vp) return reparentIntoParentPrevSibling(index, node, opts.rootId ?? null)

  // Swap: detach node, then re-insert it immediately before vp. A hidden
  // sibling between them stays put (rides along below vp).
  const rawNext = i + 1 < siblings.length ? siblings[i + 1]! : null
  if (rawNext) update(rawNext.id, { prevSiblingId: node.prevSiblingId })
  update(nodeId, { prevSiblingId: vp.prevSiblingId })
  update(vp.id, { prevSiblingId: nodeId })
  return true
}

/**
 * Move `nodeId` down among its siblings. If a visible sibling sits below it,
 * swap with that sibling. Otherwise (it is the last visible child) reparent
 * into the parent's next sibling as its first child.
 *
 * Returns true if a move happened. See ADR 0009.
 */
export function moveDown(
  index: TreeIndex,
  nodeId: string,
  opts: MoveOpts = {},
): boolean {
  const isVisible = opts.isVisible ?? (() => true)
  const node = index.byId.get(nodeId)
  if (!node) return false

  const siblings = childrenOf(index, node.parentId)
  const i = siblings.findIndex((n) => n.id === nodeId)
  if (i === -1) return false

  // Nearest visible sibling below, skipping hidden completed ones.
  let k = -1
  for (let j = i + 1; j < siblings.length; j++) {
    if (isVisible(siblings[j]!)) {
      k = j
      break
    }
  }

  if (k === -1) {
    return reparentIntoParentNextSibling(index, node, opts.rootId ?? null)
  }

  // Swap: detach node, then re-insert it immediately after vn.
  const vn = siblings[k]!
  const vnNext = k + 1 < siblings.length ? siblings[k + 1]! : null
  const rawNext = siblings[i + 1]! // exists: there's a sibling at k > i
  update(rawNext.id, { prevSiblingId: node.prevSiblingId })
  update(nodeId, { prevSiblingId: vn.id })
  if (vnNext) update(vnNext.id, { prevSiblingId: nodeId })
  return true
}

/**
 * Move `nodeId` to be a child of `newParentId`, positioned immediately after
 * `afterSiblingId` (or as the first child when `afterSiblingId` is null). This
 * is the fused move that drag-and-drop performs: it changes parent AND sibling
 * order in one shot, unlike the keyboard moves which only ever do one. See
 * ADR 0010.
 *
 * Returns true if a real move happened. No-ops (and returns false) when the
 * target is the node's current position, or when the move would create a cycle
 * (dropping a node into its own subtree).
 *
 * Like every mutation here it reads sibling order from the pre-mutation `index`
 * and relinks the `prevSiblingId` chain: detach the node (its old next sibling
 * inherits its old prev), then splice it in (the node that followed the new
 * slot now follows the node).
 */
export function moveNode(
  index: TreeIndex,
  nodeId: string,
  newParentId: string | null,
  afterSiblingId: string | null,
): boolean {
  const node = index.byId.get(nodeId)
  if (!node) return false
  // Can't land after yourself, and can't become your own parent.
  if (afterSiblingId === nodeId || newParentId === nodeId) return false

  // Cycle guard: walk up from the target parent; bail if we reach the node.
  // Dropping a branch inside itself would orphan it. See ADR 0010.
  if (newParentId !== null) {
    let cursor: Node | undefined = index.byId.get(newParentId)
    let guard = index.byId.size + 1
    while (cursor && guard-- > 0) {
      if (cursor.id === nodeId) return false
      cursor = cursor.parentId
        ? index.byId.get(cursor.parentId)
        : undefined
    }
  }

  // Already exactly here? Nothing to do (same parent, same predecessor).
  if (
    newParentId === node.parentId &&
    (afterSiblingId ?? null) === (node.prevSiblingId ?? null)
  ) {
    return false
  }

  // The node currently following us under the OLD parent inherits our old prev.
  const oldSiblings = childrenOf(index, node.parentId)
  const oi = oldSiblings.findIndex((n) => n.id === nodeId)
  const oldNext =
    oi !== -1 && oi + 1 < oldSiblings.length ? oldSiblings[oi + 1]! : null

  // The node that will follow us under the NEW parent: the one after
  // `afterSiblingId`, or the current head when we're becoming the first child.
  const newSiblings = childrenOf(index, newParentId)
  let newNext: Node | null = null
  if (afterSiblingId === null) {
    newNext = newSiblings[0] ?? null
  } else {
    const ni = newSiblings.findIndex((n) => n.id === afterSiblingId)
    newNext = ni !== -1 && ni + 1 < newSiblings.length ? newSiblings[ni + 1]! : null
  }

  // Detach, then re-splice. Reads above are all from the pre-mutation index, so
  // ordering of the writes below doesn't matter.
  if (oldNext) update(oldNext.id, { prevSiblingId: node.prevSiblingId })
  update(nodeId, { parentId: newParentId, prevSiblingId: afterSiblingId })
  if (newNext && newNext.id !== nodeId) {
    update(newNext.id, { prevSiblingId: nodeId })
  }
  return true
}

/**
 * Move several nodes to be the last children of `targetId`, in the given order
 * (node multi-selection's Move + daily's Send to Today -- ADR 0018). Returns how
 * many actually moved.
 *
 * Each node is appended after the previously-moved one, so the run keeps its
 * relative order under the target. The index is REBUILT from the live collection
 * before each `moveNode` (the prior move already applied optimistically to
 * `nodesCollection`), so sibling-chain relinks read accurate state -- looping
 * `moveNode` over a stale snapshot would tear the chain when the moved nodes
 * were siblings of each other. Wrap the whole call in `runStructural` so the N
 * moves land as ONE atomic batch (ADR 0009).
 */
export function moveManyNodes(
  targetId: string | null,
  ids: string[],
): number {
  let moved = 0
  // `after` walks forward: start at the target's current last child, then each
  // successful move becomes the predecessor of the next.
  const firstSiblings = childrenOf(
    buildTreeIndex(nodesCollection.toArray),
    targetId,
  )
  let after: string | null = firstSiblings.length
    ? firstSiblings[firstSiblings.length - 1]!.id
    : null
  for (const id of ids) {
    const index = buildTreeIndex(nodesCollection.toArray)
    if (moveNode(index, id, targetId, after)) {
      moved++
      after = id
    }
  }
  return moved
}

/**
 * Indent a contiguous sibling run (node multi-selection's Tab -- ADR 0018): move
 * every selected root to become the last children of the run's PREVIOUS sibling,
 * preserving order. No-op (returns 0) when the run is already the first child of
 * its parent (no previous sibling to indent under). The new parent is expanded if
 * collapsed so the indented run stays visible (mirrors single-node `indent`).
 * Reuses `moveManyNodes`, so it's the same rebuild-between-moves batch; wrap the
 * whole call in `runStructural` so it lands as ONE atomic frame (ADR 0009).
 */
export function indentManyNodes(rootIds: string[]): number {
  if (rootIds.length === 0) return 0
  const index = buildTreeIndex(nodesCollection.toArray)
  // The run is contiguous, so the first root's prev sibling sits OUTSIDE it --
  // the node everything indents under. Absent => first child => can't indent.
  const targetId = index.byId.get(rootIds[0]!)?.prevSiblingId
  if (!targetId) return 0
  if (index.byId.get(targetId)?.collapsed) update(targetId, { collapsed: false })
  return moveManyNodes(targetId, rootIds)
}

/**
 * Outdent a contiguous sibling run (node multi-selection's Shift+Tab -- ADR 0018):
 * move every selected root up one level, landing them immediately after their
 * former shared parent, in order. No-op (returns 0) when the run is already
 * top-level. The zoom-root boundary is the CALLER's guard (it owns view state),
 * mirroring single-node `onOutdent`. Like `moveManyNodes` it rebuilds the index
 * between moves so the sibling chain stays intact -- looping over a stale snapshot
 * would land later roots before earlier ones (each lands "right after the parent",
 * displacing the prior). Wrap in `runStructural` (ADR 0009).
 */
export function outdentManyNodes(rootIds: string[]): number {
  if (rootIds.length === 0) return 0
  const start = buildTreeIndex(nodesCollection.toArray)
  const oldParentId = start.byId.get(rootIds[0]!)?.parentId
  if (!oldParentId) return 0 // already top-level -> can't outdent
  const newParentId = start.byId.get(oldParentId)?.parentId ?? null
  let moved = 0
  // `after` walks forward from the old parent: each root lands right after the
  // previously-moved one, so the run keeps its order at the new level.
  let after: string = oldParentId
  for (const id of rootIds) {
    const index = buildTreeIndex(nodesCollection.toArray)
    if (moveNode(index, id, newParentId, after)) {
      moved++
      after = id
    }
  }
  return moved
}

/**
 * Delete a node. Children are deleted recursively (Workflowy behavior:
 * deleting a parent deletes its subtree). Returns the id to focus
 * afterwards: the next sibling if any, else the previous sibling, else
 * the parent.
 */
export function removeNode(
  index: TreeIndex,
  nodeId: string,
): string | null {
  const node = index.byId.get(nodeId)
  if (!node) return null

  // Collect subtree ids (depth-first).
  const toDelete: string[] = []
  const stack = [nodeId]
  while (stack.length) {
    const id = stack.pop()!
    toDelete.push(id)
    const kids = childrenOf(index, id)
    for (const k of kids) stack.push(k.id)
  }

  // Determine focus target before mutating.
  const siblings = childrenOf(index, node.parentId)
  const i = siblings.findIndex((n) => n.id === nodeId)
  let focusId: string | null = null
  if (i !== -1 && i + 1 < siblings.length) {
    focusId = siblings[i + 1]!.id
  } else if (i > 0) {
    focusId = siblings[i - 1]!.id
  } else {
    focusId = node.parentId
  }

  // Relink the follower of the last-deleted-in-chain. For the deleted node
  // itself, its old next sibling needs to point at node.prevSiblingId.
  if (i !== -1 && i + 1 < siblings.length) {
    const nextSibling = siblings[i + 1]!
    update(nextSibling.id, { prevSiblingId: node.prevSiblingId })
  }

  for (const id of toDelete) nodesCollection.delete(id)

  // focusId may have been deleted if it was in the subtree (it isn't, by
  // construction: focus is a sibling or ancestor), so it's safe.
  return focusId
}

/**
 * Delete several nodes and their subtrees (node multi-selection's Delete --
 * ADR 0018). The index is REBUILT from the live collection before each
 * `removeNode`, so the sibling-chain relink reads accurate state: deleting a run
 * of contiguous siblings off ONE stale snapshot would dangle the chain (each
 * delete repoints the follower to the just-deleted node's prev). Order-agnostic
 * with the rebuild. Wrap in `runStructural` so the whole set is one atomic batch.
 * Focus handling is the caller's (computed before deletion).
 */
export function removeManyNodes(ids: string[]): void {
  for (const id of ids) {
    removeNode(buildTreeIndex(nodesCollection.toArray), id)
  }
}

export function setText(nodeId: string, text: string) {
  update(nodeId, { text })
}

export function toggleCompleted(nodeId: string, completed: boolean) {
  update(nodeId, { completed })
}

/**
 * Make a bullet a task (gains a checkbox) or a plain bullet. `isTask` is
 * purely a display choice and is independent of `completed`: a plain bullet
 * keeps whatever done-status it had. See ADR 0001.
 */
export function setIsTask(nodeId: string, isTask: boolean) {
  update(nodeId, { isTask })
}

export function toggleCollapsed(nodeId: string, collapsed: boolean) {
  update(nodeId, { collapsed })
}

/**
 * Pin or unpin a node as a bookmark. Stores the moment it was pinned (the
 * bookmarks list sorts by it) or `null` to unpin. See ADR 0011.
 */
export function toggleBookmark(nodeId: string, bookmarked: boolean) {
  update(nodeId, { bookmarkedAt: bookmarked ? now() : null })
}
