import { nodesCollection } from './collection'
import type { Node } from './schema'
import type { TreeIndex } from './tree'

/**
 * Undo history for the outline.
 *
 * Strategy: full-state snapshots. Before every user action we push a deep
 * copy of all nodes; undo reconciles the live collection back to the most
 * recent snapshot (delete added rows, re-insert removed ones, update changed
 * ones). TanStack DB has no built-in undo -- its rollback only covers failed
 * sync -- so we own this. Snapshots beat inverse-patches here because the
 * sibling-relinking mutations are intricate and a snapshot can't drift out of
 * sync with them. The outline is small (a personal doc), so copying the whole
 * node set per action is cheap; we still cap the stack to bound memory.
 *
 * Like mutations.ts, this operates on the singleton collection directly.
 */

interface Entry {
  nodes: Node[]
  /** Node to focus after this entry is restored (the pre-action focus). */
  focusId: string | null
  /** Coalesces consecutive same-tag captures (e.g. a typing run) into one. */
  tag: string | null
}

const undoStack: Entry[] = []
const MAX_ENTRIES = 100

function snapshot(index: TreeIndex): Node[] {
  // Nodes are flat records, so a shallow per-node copy is a full deep copy.
  return Array.from(index.byId.values()).map((n) => ({ ...n }))
}

/**
 * Record an undo point, captured BEFORE the mutation runs so it holds the
 * pre-action state.
 *
 * `tag` coalesces: if the top of the stack has the same non-null tag, we skip
 * pushing. Pass `text:<id>` for keystrokes so an entire typing run on one
 * bullet collapses to a single undo step; pass null for discrete structural
 * actions so each is independently undoable.
 */
export function capture(
  index: TreeIndex,
  focusId: string | null = null,
  tag: string | null = null,
): void {
  const top = undoStack[undoStack.length - 1]
  if (tag !== null && top && top.tag === tag) return
  undoStack.push({ nodes: snapshot(index), focusId, tag })
  if (undoStack.length > MAX_ENTRIES) undoStack.shift()
}

/**
 * Drop the most recent undo point. Used when a command captured but its
 * mutation turned out to be a no-op (e.g. indent at the top of a list), so we
 * don't leave a redundant entry that makes Cmd+Z look like it did nothing.
 */
export function drop(): void {
  undoStack.pop()
}

export function canUndo(): boolean {
  return undoStack.length > 0
}

/**
 * Restore the most recent undo point by reconciling the live collection
 * against the snapshot. Returns the id to focus afterwards, or null if there
 * was nothing to undo.
 */
export function undo(index: TreeIndex): string | null {
  const entry = undoStack.pop()
  if (!entry) return null

  const target = new Map(entry.nodes.map((n) => [n.id, n]))
  const current = index.byId

  // Anything that exists now but not in the snapshot was added since: remove it.
  for (const id of current.keys()) {
    if (!target.has(id)) nodesCollection.delete(id)
  }
  // Re-insert removed nodes and overwrite changed ones to match the snapshot.
  for (const [id, node] of target) {
    if (!current.has(id)) {
      nodesCollection.insert({ ...node })
    } else {
      nodesCollection.update(id, (draft) => Object.assign(draft, node))
    }
  }

  // Only focus if the node still exists in the restored state.
  return entry.focusId && target.has(entry.focusId) ? entry.focusId : null
}
