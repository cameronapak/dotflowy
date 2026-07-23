/**
 * ADR 0004 handoff seam — build Dotflowy-shaped `TreeIndex` / ordered children
 * from Lunora collection rows (`wholeOutline`). Ported from
 * `spikes/lunora-outline/src/outline/lunora-bridge.ts`.
 */

import type { NodeDocLike, OutlineNode, TreeIndex } from "./outline-plans";
import type { Node } from "./schema";

import { buildTreeIndex, childrenOf, rowToNode } from "./outline-plans";

/** Map collection / query rows → planner nodes. */
export function rowsToOutlineNodes(rows: Iterable<NodeDocLike>): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const row of rows) out.push(rowToNode(row));
  return out;
}

/** Drop Lunora-only `userId` so tree-store / editor see wire `Node`. */
export function outlineNodeToNode(node: OutlineNode): Node {
  const { userId: _userId, ...rest } = node;
  return rest;
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
