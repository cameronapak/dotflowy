import { nodesCollection } from './collection'
import type { Node } from './schema'
import type { TreeIndex } from './tree'

/**
 * Undo/redo history for the outline.
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
 * Redo is the mirror image: undo pushes the pre-undo state onto a redo stack
 * before restoring, and redo pops it back (pushing the pre-redo state onto the
 * undo stack). Any fresh `capture` clears the redo stack -- a new action forks
 * the timeline, so the old forward history is gone. `drop` restores it, since a
 * captured-then-dropped no-op never actually changed anything.
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
const redoStack: Entry[] = []
const MAX_ENTRIES = 100

// The redo stack as it stood just before the most recent `capture` cleared it,
// so a captured-then-dropped no-op can put it back (see `drop`).
let redoBackup: Entry[] | null = null

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
  // A fresh action forks the timeline: the forward history no longer applies.
  // Stash it first so a no-op that gets dropped can restore it.
  redoBackup = redoStack.slice()
  redoStack.length = 0
}

/**
 * Drop the most recent undo point. Used when a command captured but its
 * mutation turned out to be a no-op (e.g. indent at the top of a list), so we
 * don't leave a redundant entry that makes Cmd+Z look like it did nothing.
 * Also restores the redo stack the matching `capture` cleared, since a no-op
 * never actually forked the timeline.
 */
export function drop(): void {
  undoStack.pop()
  if (redoBackup) {
    redoStack.length = 0
    redoStack.push(...redoBackup)
    redoBackup = null
  }
}

export function canUndo(): boolean {
  return undoStack.length > 0
}

export function canRedo(): boolean {
  return redoStack.length > 0
}

/**
 * Reconcile the live collection to `entry`'s snapshot. Returns the id to focus
 * afterwards, or null if that node no longer exists in the restored state.
 */
function restore(index: TreeIndex, entry: Entry): string | null {
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

/**
 * Restore the most recent undo point. Before overwriting the live state we push
 * it onto the redo stack (tagged with the currently-focused node) so redo can
 * return to it. Returns the id to focus afterwards, or null if there was
 * nothing to undo.
 */
export function undo(index: TreeIndex, focusId: string | null = null): string | null {
  const entry = undoStack.pop()
  if (!entry) return null

  redoStack.push({ nodes: snapshot(index), focusId, tag: null })
  if (redoStack.length > MAX_ENTRIES) redoStack.shift()

  return restore(index, entry)
}

/**
 * Re-apply the most recently undone action. The mirror of `undo`: push the
 * current (pre-redo) state back onto the undo stack, then restore the redo
 * snapshot. Returns the id to focus afterwards, or null if there was nothing to
 * redo.
 */
export function redo(index: TreeIndex, focusId: string | null = null): string | null {
  const entry = redoStack.pop()
  if (!entry) return null

  undoStack.push({ nodes: snapshot(index), focusId, tag: null })
  if (undoStack.length > MAX_ENTRIES) undoStack.shift()

  return restore(index, entry)
}
