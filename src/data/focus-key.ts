import { nodesCollection } from './collection'
import { isMirrorsEnabled } from './flags'
import type { Node } from './schema'
import { buildTreeIndex } from './tree'
import { getViewIsHidden, getViewRootId } from './view-state'
import { buildVisibleRows, focusKeyAfterEdit } from './visible-order'

/**
 * The render key to focus after a structural edit, re-derived from the LIVE post-
 * edit render walk so the focus key can never drift from what's on screen (ADR
 * 0022, Stage 2c). `instanceId` is the new/moved node; `activeKey` is the row the
 * user was editing -- we return the matching instance's key under the same mirror
 * anchor, so a child added to a source lands under the mirror you were in (not the
 * source's far-away copy).
 *
 * Off the flag (the 99% path) a node id is unique, so we return it directly and
 * skip the rebuild entirely. With the flag on we build a fresh index from
 * `nodesCollection.toArray` -- synchronously current after `runStructural`, the
 * same technique the structural invariant check uses -- rather than
 * `getTreeIndex()`, whose change-notify can lag the optimistic apply.
 *
 * Lives here rather than beside its first caller because the markdown paste
 * (ADR 0044) needs it too, from a module the editor imports.
 */
export function focusKeyFor(instanceId: string, activeKey: string): string {
  if (!isMirrorsEnabled()) return instanceId
  const index = buildTreeIndex(nodesCollection.toArray as Node[])
  const rows = buildVisibleRows(index, getViewRootId(), getViewIsHidden(), null, true)
  return focusKeyAfterEdit(rows, instanceId, activeKey) ?? instanceId
}
