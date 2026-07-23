import type { TreeIndex } from "../tree";
import type { OutlineNode, OutlinePlan } from "./types";

import { childrenOf, makeNode } from "../tree";
import { emptyPlan } from "./types";

/** Dotflowy `makeNode` + Lunora shard `userId`. */
export function makeOutlineNode(
  partial: Partial<OutlineNode> & Pick<OutlineNode, "id" | "userId">,
): OutlineNode {
  const { userId, ...rest } = partial;
  return { ...makeNode({ id: partial.id, ...rest }), userId };
}

/**
 * Mid-list insert: new node after `afterId` under `parentId`, repointing the
 * follower. Port of Dotflowy `insertSibling` + worker `planAddNode` mid-list.
 */
export function planInsertSibling(
  index: TreeIndex,
  args: {
    id: string;
    userId: string;
    parentId: string | null;
    afterId: string | null;
    text: string;
    isTask?: boolean;
    kind?: "paragraph" | null;
    createdAt: number;
    updatedAt: number;
  },
): OutlinePlan | null {
  if (args.parentId !== null && !index.byId.has(args.parentId)) return null;

  const siblings = childrenOf(index, args.parentId);
  let nextSiblingId: string | null = null;
  if (args.afterId) {
    const i = siblings.findIndex((n) => n.id === args.afterId);
    if (i === -1) return null;
    if (i + 1 < siblings.length) nextSiblingId = siblings[i + 1]!.id;
  } else if (siblings.length > 0) {
    // afterId null = insert as head
    nextSiblingId = siblings[0]!.id;
  }

  const plan = emptyPlan();
  plan.inserts.push(
    makeOutlineNode({
      id: args.id,
      userId: args.userId,
      parentId: args.parentId,
      prevSiblingId: args.afterId,
      text: args.text,
      isTask: args.isTask ?? false,
      kind: args.kind ?? null,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    }),
  );

  if (nextSiblingId) {
    plan.patches.push({
      id: nextSiblingId,
      fields: { prevSiblingId: args.id, updatedAt: args.updatedAt },
    });
  }

  return plan;
}

/**
 * Indent: become last child of previous sibling. Port of Dotflowy `indent`.
 */
export function planIndent(
  index: TreeIndex,
  nodeId: string,
  updatedAt: number,
): OutlinePlan | null {
  const node = index.byId.get(nodeId);
  if (!node || !node.prevSiblingId) return null;

  const newParent = index.byId.get(node.prevSiblingId);
  if (!newParent) return null;

  const oldSiblings = childrenOf(index, node.parentId);
  const i = oldSiblings.findIndex((n) => n.id === nodeId);
  const oldNext =
    i !== -1 && i + 1 < oldSiblings.length ? oldSiblings[i + 1]! : null;

  const newSiblings = childrenOf(index, newParent.id);
  const lastExisting =
    newSiblings.length > 0 ? newSiblings[newSiblings.length - 1]! : null;

  const plan = emptyPlan();
  plan.patches.push({
    id: nodeId,
    fields: {
      parentId: newParent.id,
      prevSiblingId: lastExisting ? lastExisting.id : null,
      updatedAt,
    },
  });

  if (newParent.collapsed) {
    plan.patches.push({
      id: newParent.id,
      fields: { collapsed: false, updatedAt },
    });
  }

  if (oldNext) {
    plan.patches.push({
      id: oldNext.id,
      fields: { prevSiblingId: node.prevSiblingId, updatedAt },
    });
  }

  return plan;
}

/**
 * Outdent: become sibling immediately after former parent. Port of `outdent`.
 */
export function planOutdent(
  index: TreeIndex,
  nodeId: string,
  updatedAt: number,
): OutlinePlan | null {
  const node = index.byId.get(nodeId);
  if (!node || node.parentId === null) return null;

  const oldParent = index.byId.get(node.parentId);
  if (!oldParent) return null;

  const newParentId = oldParent.parentId;

  const oldSiblings = childrenOf(index, oldParent.id);
  const i = oldSiblings.findIndex((n) => n.id === nodeId);
  const oldNext =
    i !== -1 && i + 1 < oldSiblings.length ? oldSiblings[i + 1]! : null;

  const newSiblings = childrenOf(index, newParentId);
  const parentIdx = newSiblings.findIndex((n) => n.id === oldParent.id);
  const afterParent =
    parentIdx !== -1 && parentIdx + 1 < newSiblings.length
      ? newSiblings[parentIdx + 1]!
      : null;

  const plan = emptyPlan();
  plan.patches.push({
    id: nodeId,
    fields: {
      parentId: newParentId,
      prevSiblingId: oldParent.id,
      updatedAt,
    },
  });

  if (oldNext) {
    plan.patches.push({
      id: oldNext.id,
      fields: { prevSiblingId: node.prevSiblingId, updatedAt },
    });
  }

  if (afterParent) {
    plan.patches.push({
      id: afterParent.id,
      fields: { prevSiblingId: nodeId, updatedAt },
    });
  }

  return plan;
}

/**
 * Cascade delete subtree + relink follower. Port of `planDeleteNode`.
 */
export function planRemoveNode(
  index: TreeIndex,
  nodeId: string,
  updatedAt: number,
): OutlinePlan | null {
  const node = index.byId.get(nodeId);
  if (!node) return null;

  const deletedIds: string[] = [];
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    deletedIds.push(id);
    for (const child of childrenOf(index, id)) stack.push(child.id);
  }

  const plan = emptyPlan();
  const siblings = childrenOf(index, node.parentId);
  const i = siblings.findIndex((n) => n.id === nodeId);
  if (i !== -1 && i + 1 < siblings.length) {
    const next = siblings[i + 1]!;
    plan.patches.push({
      id: next.id,
      fields: { prevSiblingId: node.prevSiblingId, updatedAt },
    });
  }
  plan.deletes.push(...deletedIds);
  return plan;
}

/** Field-only text update. */
export function planSetText(
  index: TreeIndex,
  nodeId: string,
  text: string,
  updatedAt: number,
): OutlinePlan | null {
  if (!index.byId.has(nodeId)) return null;
  const plan = emptyPlan();
  plan.patches.push({ id: nodeId, fields: { text, updatedAt } });
  return plan;
}

/** Apply a plan to an in-memory node list (for unit tests / working copies). */
export function applyPlan(
  nodes: OutlineNode[],
  plan: OutlinePlan,
): OutlineNode[] {
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]));

  for (const id of plan.deletes) byId.delete(id);

  for (const patch of plan.patches) {
    const row = byId.get(patch.id);
    if (row) Object.assign(row, patch.fields);
  }

  for (const insert of plan.inserts) {
    byId.set(insert.id, { ...insert });
  }

  return [...byId.values()];
}
