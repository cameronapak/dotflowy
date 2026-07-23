import type { OutlineNode } from "./types.js";

import { orderSiblings } from "./sibling-chain.js";

/** Synthetic parent key for top-level nodes (`parentId === null`). */
const ROOT_PARENT = "__root__";

export type TreeIndex = {
  childrenByParent: Map<string, string[]>;
  byId: Map<string, OutlineNode>;
};

export function parentKeyOf(node: OutlineNode): string {
  return node.parentId ?? ROOT_PARENT;
}

export function buildTreeIndex(nodes: OutlineNode[]): TreeIndex {
  const byId = new Map<string, OutlineNode>();
  const unsorted = new Map<string, OutlineNode[]>();

  for (const node of nodes) {
    byId.set(node.id, node);
    const key = parentKeyOf(node);
    const list = unsorted.get(key);
    if (list) list.push(node);
    else unsorted.set(key, [node]);
  }

  const childrenByParent = new Map<string, string[]>();
  for (const [parentKey, list] of unsorted) {
    childrenByParent.set(
      parentKey,
      orderSiblings(list).map((n) => n.id),
    );
  }

  return { childrenByParent, byId };
}

export function childrenOf(
  index: TreeIndex,
  parentId: string | null,
): OutlineNode[] {
  const ids = index.childrenByParent.get(parentId ?? ROOT_PARENT);
  if (!ids) return [];
  const out: OutlineNode[] = [];
  for (const id of ids) {
    const node = index.byId.get(id);
    if (node) out.push(node);
  }
  return out;
}

export function makeNode(
  partial: Partial<OutlineNode> & Pick<OutlineNode, "id" | "userId">,
): OutlineNode {
  return {
    parentId: null,
    prevSiblingId: null,
    text: "",
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: 0,
    updatedAt: 0,
    origin: null,
    kind: null,
    ...partial,
  };
}
