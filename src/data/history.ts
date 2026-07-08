import { nodesCollection } from './collection'
import type { Node } from './schema'
import type { TreeIndex } from './tree'
import { instanceIdForKey } from './visible-order'

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
 * `undo`/`redo` return a `RestorePlan` -- the snapshot diff pre-chunked into
 * apply slices -- instead of writing to the collection themselves, so the
 * caller can pick the apply path by size: a small diff (the common,
 * keystroke-adjacent case) runs synchronously through `runStructural`, while a
 * huge one (undoing a 17k-node OPML import or big delete) streams through
 * `runStructuralSliced` with progress UI instead of freezing the main thread.
 * See `components/history-restore.tsx`, the single funnel both paths share.
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

/**
 * At or above this many collection writes a restore should stream through
 * `runStructuralSliced` (yielding slices + progress UI) instead of one
 * synchronous burst; it doubles as the per-slice write count. Matches the OPML
 * import / big-delete slice size (ADR 0037).
 */
export const RESTORE_SLICE_OPS = 500

/**
 * A snapshot restore, planned but not yet applied. The caller must run EVERY
 * slice, in order, inside ONE transaction -- a `runStructural` body for the
 * small case, one `runStructuralSliced` call for the big one -- or call
 * `revert` if the apply failed and rolled back.
 */
export interface RestorePlan {
  /** Total collection writes the restore will make. */
  opCount: number
  /** Apply closures in order; each makes at most RESTORE_SLICE_OPS writes. */
  slices: ReadonlyArray<() => void>
  /** Writes applied so far -- the sliced path's progress read. */
  applied: () => number
  /** Row key to focus after the restore, or null if that node is gone. */
  focusId: string | null
  /** Roll the stack bookkeeping back after a failed (rolled-back) apply. */
  revert: () => void
}

/**
 * Two snapshots of a node are equal when every field matches; nodes are flat
 * records, so a shallow field compare is a full compare.
 */
function sameNode(a: Node, b: Node): boolean {
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = Object.keys(ra)
  if (keys.length !== Object.keys(rb).length) return false
  for (const key of keys) if (ra[key] !== rb[key]) return false
  return true
}

/**
 * Diff the live collection against `entry`'s snapshot into chunked apply
 * slices: delete rows added since, re-insert removed ones, overwrite changed
 * ones. Unchanged nodes are skipped -- the diff size is also what picks the
 * sync-vs-sliced apply path, so it must reflect real writes, not outline size.
 */
function planRestore(index: TreeIndex, entry: Entry, revert: () => void): RestorePlan {
  const target = new Map(entry.nodes.map((n) => [n.id, n]))
  const current = index.byId

  // Anything that exists now but not in the snapshot was added since: remove it.
  const deletes: string[] = []
  for (const id of current.keys()) {
    if (!target.has(id)) deletes.push(id)
  }
  // Re-insert removed nodes; overwrite only the ones that actually changed.
  const upserts: Node[] = []
  for (const [id, node] of target) {
    const live = current.get(id)
    if (!live || !sameNode(live, node)) upserts.push(node)
  }

  let applied = 0
  const slices: Array<() => void> = []
  for (let i = 0; i < deletes.length; i += RESTORE_SLICE_OPS) {
    const chunk = deletes.slice(i, i + RESTORE_SLICE_OPS)
    slices.push(() => {
      for (const id of chunk) nodesCollection.delete(id)
      applied += chunk.length
    })
  }
  for (let i = 0; i < upserts.length; i += RESTORE_SLICE_OPS) {
    const chunk = upserts.slice(i, i + RESTORE_SLICE_OPS)
    slices.push(() => {
      // Insert-vs-update is decided at apply time: an earlier slice (or the
      // surrounding transaction) may already have written the row.
      for (const node of chunk) {
        if (nodesCollection.has(node.id)) {
          nodesCollection.update(node.id, (draft) => Object.assign(draft, node))
        } else {
          nodesCollection.insert({ ...node })
        }
      }
      applied += chunk.length
    })
  }

  return {
    opCount: deletes.length + upserts.length,
    slices,
    applied: () => applied,
    // Only focus if the focused node still exists in the restored state. The focus
    // identity may be a row KEY (a path address inside a mirror, ADR 0022); gate on
    // the node it points at (the key's last segment) but return the full key, so
    // focus lands back in the same instance the user was editing. For a mirror-free
    // row key === id, so this is identical to a bare-id check.
    focusId:
      entry.focusId && target.has(instanceIdForKey(entry.focusId))
        ? entry.focusId
        : null,
    revert,
  }
}

/**
 * Plan a restore of the most recent undo point. Before handing out the plan we
 * push the live state onto the redo stack (tagged with the currently-focused
 * node) so redo can return to it. Returns null if there was nothing to undo.
 */
export function undo(index: TreeIndex, focusId: string | null = null): RestorePlan | null {
  const entry = undoStack.pop()
  if (!entry) return null

  redoStack.push({ nodes: snapshot(index), focusId, tag: null })
  const overflow = redoStack.length > MAX_ENTRIES ? redoStack.shift() : undefined

  return planRestore(index, entry, () => {
    redoStack.pop()
    if (overflow) redoStack.unshift(overflow)
    undoStack.push(entry)
  })
}

/**
 * Plan a re-apply of the most recently undone action. The mirror of `undo`:
 * push the current (pre-redo) state back onto the undo stack, then plan the
 * restore of the redo snapshot. Returns null if there was nothing to redo.
 */
export function redo(index: TreeIndex, focusId: string | null = null): RestorePlan | null {
  const entry = redoStack.pop()
  if (!entry) return null

  undoStack.push({ nodes: snapshot(index), focusId, tag: null })
  const overflow = undoStack.length > MAX_ENTRIES ? undoStack.shift() : undefined

  return planRestore(index, entry, () => {
    undoStack.pop()
    if (overflow) undoStack.unshift(overflow)
    redoStack.push(entry)
  })
}
