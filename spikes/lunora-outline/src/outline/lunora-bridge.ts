/**
 * ADR 0004 handoff seam — build Dotflowy-shaped `TreeIndex` / ordered children
 * from Lunora collection rows (`wholeOutline`). Feed `tree-store` later; do
 * **not** port OutlineEditor / virtualizer into this spike.
 */

import type { OutlineNode, TreeIndex } from "@dotflowy/outline-plans";

import {
  buildTreeIndex,
  childrenOf,
  rowToNode,
  type NodeDocLike,
} from "@dotflowy/outline-plans";

/** Map collection / query rows → planner nodes. */
export function rowsToOutlineNodes(rows: Iterable<NodeDocLike>): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const row of rows) out.push(rowToNode(row));
  return out;
}

/** Lunora rows → TreeIndex (ordered sibling ids per parent). */
export function bridgeTreeIndex(rows: Iterable<NodeDocLike>): TreeIndex {
  return buildTreeIndex(rowsToOutlineNodes(rows));
}

/** Ordered children under `parentId` (`null` = top level). */
export function bridgeOrderedChildren(
  index: TreeIndex,
  parentId: string | null,
): OutlineNode[] {
  return childrenOf(index, parentId) as OutlineNode[];
}
