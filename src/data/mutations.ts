import { nodesCollection } from './collection'
import {
  type Node,
  type TreeIndex,
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
 * Returns the new node's id so the editor can focus it.
 */
export function insertSibling(
  index: TreeIndex,
  parentId: string | null,
  afterId: string | null,
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
    makeNode({ id, parentId, prevSiblingId, text: '' }),
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
 * Returns the new node's id so the editor can focus it.
 */
export function insertChildAtStart(
  index: TreeIndex,
  parentId: string | null,
): string {
  const id = createId()
  const head = childrenOf(index, parentId)[0] ?? null

  nodesCollection.insert(
    makeNode({ id, parentId, prevSiblingId: null, text: '' }),
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
 * Pass `prevSiblingId` explicitly so seed code owns the wiring.
 */
export function appendChild(
  parentId: string | null,
  prevSiblingId: string | null = null,
  text = '',
): string {
  const id = createId()
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
    if (nextSibling.id !== focusId || focusId === nextSibling.id) {
      update(nextSibling.id, { prevSiblingId: node.prevSiblingId })
    }
  }

  for (const id of toDelete) nodesCollection.delete(id)

  // focusId may have been deleted if it was in the subtree (it isn't, by
  // construction: focus is a sibling or ancestor), so it's safe.
  return focusId
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
 * keeps whatever done-status it had. See docs/adr/0001.
 */
export function setIsTask(nodeId: string, isTask: boolean) {
  update(nodeId, { isTask })
}

export function toggleCollapsed(nodeId: string, collapsed: boolean) {
  update(nodeId, { collapsed })
}
