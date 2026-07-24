/**
 * Live outline rows for event-time reads that must see optimistic writes
 * synchronously (selection refresh, markdown paste seam, multi-node mirror).
 *
 * Flag OFF → classic `nodesCollection`. Flag ON → Lunora `wholeOutline`
 * collection (not `getTreeIndex()`, whose notify can lag the mutator apply —
 * same reason `refreshSelection` historically read the collection directly).
 */

import type { Node } from "./schema";

import { nodesCollection } from "./collection";
import { isLunoraSyncEnabled } from "./flags";
import { outlineNodeToNode } from "./lunora-bridge";
import { getLunoraOutlineContext } from "./lunora-sync";
import { rowToNode, type OutlineNode } from "./outline-plans";

/** Wire-shaped nodes (no Lunora `userId`) — selection / tree-index callers. */
export function getLiveNodes(): Node[] {
  if (isLunoraSyncEnabled()) {
    const lunora = getLunoraOutlineContext();
    if (lunora) {
      return lunora.store.collection.toArray.map((row) =>
        outlineNodeToNode(rowToNode(row)),
      );
    }
  }
  return nodesCollection.toArray as Node[];
}

/** Planner nodes with shard `userId` — Lunora mutator args (restore/import). */
export function getLiveOutlineNodes(): OutlineNode[] {
  const lunora = getLunoraOutlineContext();
  if (!lunora) return [];
  return lunora.store.collection.toArray.map(rowToNode);
}
