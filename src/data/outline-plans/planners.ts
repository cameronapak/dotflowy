import type { Node } from "../schema";
import type { TreeIndex } from "../tree";
import type { OutlineNode, OutlinePlan, PlanPatch } from "./types";

import {
  buildTreeIndex,
  childrenOf,
  makeNode,
  trueSourceOf,
  wouldMirrorCycle,
} from "../tree";
import { emptyPlan } from "./types";

/** Dotflowy `makeNode` + Lunora shard `userId`. */
export function makeOutlineNode(
  partial: Partial<OutlineNode> & Pick<OutlineNode, "id" | "userId">,
): OutlineNode {
  const { userId, id, ...rest } = partial;
  return { ...makeNode({ id, ...rest }), userId };
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
 *
 * `resolveMirror` (ADR 0022): when the previous sibling is a mirror, parent into
 * its SOURCE (`trueSourceOf`) so the node windows into every instance — matching
 * classic `mutations.indent(…, resolveMirror)`. Collapse still targets the
 * visible instance.
 */
export function planIndent(
  index: TreeIndex,
  nodeId: string,
  updatedAt: number,
  resolveMirror = false,
): OutlinePlan | null {
  const node = index.byId.get(nodeId);
  if (!node || !node.prevSiblingId) return null;

  const newParent = index.byId.get(node.prevSiblingId);
  if (!newParent) return null;

  const newParentContentId = resolveMirror
    ? trueSourceOf(index, newParent.id)
    : newParent.id;

  if (resolveMirror) {
    let cursor: Node | undefined = index.byId.get(newParentContentId);
    let guard = index.byId.size + 1;
    while (cursor && guard-- > 0) {
      if (cursor.id === nodeId) return null;
      cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined;
    }
  }

  const oldSiblings = childrenOf(index, node.parentId);
  const i = oldSiblings.findIndex((n) => n.id === nodeId);
  const oldNext =
    i !== -1 && i + 1 < oldSiblings.length ? oldSiblings[i + 1]! : null;

  const newSiblings = childrenOf(index, newParentContentId);
  const lastExisting =
    newSiblings.length > 0 ? newSiblings[newSiblings.length - 1]! : null;

  const plan = emptyPlan();
  plan.patches.push({
    id: nodeId,
    fields: {
      parentId: newParentContentId,
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

/**
 * Insert as FIRST child of `parentId` (push current head down). Port of
 * Dotflowy `insertChildAtStart` / worker `planAddNode` position `'first'`.
 * Same chain surgery as `planInsertSibling` with `afterId: null`.
 */
export function planInsertChildAtStart(
  index: TreeIndex,
  args: {
    id: string;
    userId: string;
    parentId: string | null;
    text: string;
    isTask?: boolean;
    kind?: "paragraph" | null;
    createdAt: number;
    updatedAt: number;
  },
): OutlinePlan | null {
  return planInsertSibling(index, { ...args, afterId: null });
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

export function planSetCompleted(
  index: TreeIndex,
  nodeId: string,
  completed: boolean,
  updatedAt: number,
): OutlinePlan | null {
  if (!index.byId.has(nodeId)) return null;
  const plan = emptyPlan();
  plan.patches.push({ id: nodeId, fields: { completed, updatedAt } });
  return plan;
}

export function planSetCollapsed(
  index: TreeIndex,
  nodeId: string,
  collapsed: boolean,
  updatedAt: number,
): OutlinePlan | null {
  if (!index.byId.has(nodeId)) return null;
  const plan = emptyPlan();
  plan.patches.push({ id: nodeId, fields: { collapsed, updatedAt } });
  return plan;
}

/**
 * Make task / plain bullet. Clears `kind` (ADR 0045 exclusivity — mirrors
 * `setIsTask` / worker `planUpdateNode`).
 */
export function planSetIsTask(
  index: TreeIndex,
  nodeId: string,
  isTask: boolean,
  updatedAt: number,
): OutlinePlan | null {
  if (!index.byId.has(nodeId)) return null;
  const plan = emptyPlan();
  plan.patches.push({ id: nodeId, fields: { isTask, kind: null, updatedAt } });
  return plan;
}

/**
 * Paragraph ↔ bullet. Always clears `isTask` (ADR 0045 — mirrors `setKind`).
 */
export function planSetKind(
  index: TreeIndex,
  nodeId: string,
  kind: "paragraph" | null,
  updatedAt: number,
): OutlinePlan | null {
  if (!index.byId.has(nodeId)) return null;
  const plan = emptyPlan();
  plan.patches.push({
    id: nodeId,
    fields: { kind, isTask: false, updatedAt },
  });
  return plan;
}

export function planSetBookmarkedAt(
  index: TreeIndex,
  nodeId: string,
  bookmarkedAt: number | null,
  updatedAt: number,
): OutlinePlan | null {
  if (!index.byId.has(nodeId)) return null;
  const plan = emptyPlan();
  plan.patches.push({ id: nodeId, fields: { bookmarkedAt, updatedAt } });
  return plan;
}

/**
 * Reparent + sibling-chain splice (port of Dotflowy `moveNode` /
 * worker `applyMoveInPlace`). Optional `expandIds` uncollapse uncle/aunt on
 * edge keyboard moves.
 */
export function planMoveNode(
  index: TreeIndex,
  args: {
    id: string;
    newParentId: string | null;
    afterSiblingId: string | null;
    updatedAt: number;
    expandIds?: readonly string[];
  },
): OutlinePlan | null {
  const node = index.byId.get(args.id);
  if (!node) return null;
  if (args.afterSiblingId === args.id || args.newParentId === args.id)
    return null;

  if (args.newParentId !== null) {
    let cursor = index.byId.get(args.newParentId);
    let guard = index.byId.size + 1;
    while (cursor && guard-- > 0) {
      if (cursor.id === args.id) return null;
      cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined;
    }
  }

  if (
    args.newParentId === node.parentId &&
    (args.afterSiblingId ?? null) === (node.prevSiblingId ?? null)
  ) {
    if (!args.expandIds?.length) return null;
    const plan = emptyPlan();
    for (const expandId of args.expandIds) {
      if (index.byId.has(expandId)) {
        plan.patches.push({
          id: expandId,
          fields: { collapsed: false, updatedAt: args.updatedAt },
        });
      }
    }
    return plan.patches.length ? plan : null;
  }

  const oldSiblings = childrenOf(index, node.parentId);
  const oi = oldSiblings.findIndex((n) => n.id === args.id);
  const oldNext =
    oi !== -1 && oi + 1 < oldSiblings.length ? oldSiblings[oi + 1]! : null;

  const newSiblings = childrenOf(index, args.newParentId);
  let newNext: { id: string } | null = null;
  if (args.afterSiblingId === null) {
    newNext = newSiblings[0] ?? null;
  } else {
    const ni = newSiblings.findIndex((n) => n.id === args.afterSiblingId);
    newNext =
      ni !== -1 && ni + 1 < newSiblings.length ? newSiblings[ni + 1]! : null;
  }

  const plan = emptyPlan();
  if (args.expandIds) {
    for (const expandId of args.expandIds) {
      if (index.byId.has(expandId)) {
        plan.patches.push({
          id: expandId,
          fields: { collapsed: false, updatedAt: args.updatedAt },
        });
      }
    }
  }
  if (oldNext) {
    plan.patches.push({
      id: oldNext.id,
      fields: {
        prevSiblingId: node.prevSiblingId,
        updatedAt: args.updatedAt,
      },
    });
  }
  plan.patches.push({
    id: args.id,
    fields: {
      parentId: args.newParentId,
      prevSiblingId: args.afterSiblingId,
      updatedAt: args.updatedAt,
    },
  });
  if (newNext && newNext.id !== args.id) {
    plan.patches.push({
      id: newNext.id,
      fields: { prevSiblingId: args.id, updatedAt: args.updatedAt },
    });
  }
  return plan;
}

/**
 * Enter mid-split: setText(left) + insertSibling(right) in ONE plan so Lunora
 * commits them under a single watermark (avoids two mutator round-trips).
 */
export function planSplitNode(
  index: TreeIndex,
  args: {
    id: string;
    userId: string;
    parentId: string | null;
    afterId: string;
    newId: string;
    leftText: string;
    rightText: string;
    isTask?: boolean;
    kind?: "paragraph" | null;
    createdAt: number;
    updatedAt: number;
  },
): OutlinePlan | null {
  if (!index.byId.has(args.id)) return null;
  const insert = planInsertSibling(index, {
    id: args.newId,
    userId: args.userId,
    parentId: args.parentId,
    afterId: args.afterId,
    text: args.rightText,
    isTask: args.isTask,
    kind: args.kind,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
  });
  if (!insert) return null;

  const plan = emptyPlan();
  plan.inserts.push(...insert.inserts);
  plan.patches.push(...insert.patches);
  plan.patches.push({
    id: args.id,
    fields: { text: args.leftText, updatedAt: args.updatedAt },
  });
  return plan;
}

/**
 * Flat-record equality for restore diffs. Nodes are shallow; `userId` is
 * Lunora-only and ignored so history snapshots (`Node`) compare cleanly.
 */
export function sameNodeFields(a: Node, b: Node): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of Object.keys(ra)) {
    if (key === "userId") continue;
    if (ra[key] !== rb[key]) return false;
  }
  for (const key of Object.keys(rb)) {
    if (key === "userId") continue;
    if (!(key in ra)) return false;
  }
  return true;
}

/** Full field snapshot for a restore patch (every Node field except `id`). */
function restorePatchFields(node: OutlineNode): PlanPatch["fields"] {
  return {
    parentId: node.parentId,
    prevSiblingId: node.prevSiblingId,
    text: node.text,
    isTask: node.isTask,
    completed: node.completed,
    collapsed: node.collapsed,
    bookmarkedAt: node.bookmarkedAt,
    mirrorOf: node.mirrorOf,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    origin: node.origin,
    kind: node.kind,
  };
}

/**
 * Snapshot restore → one OutlinePlan (deletes + inserts + full-field patches).
 * Port of `history.ts` planRestore diff — used by Lunora `restoreNodes` and
 * unit-tested here so undo/redo doesn't invent a second planner.
 */
export function planRestoreNodes(
  current: readonly OutlineNode[],
  target: readonly OutlineNode[],
): OutlinePlan {
  const targetById = new Map(target.map((n) => [n.id, n]));
  const currentById = new Map(current.map((n) => [n.id, n]));
  const plan = emptyPlan();

  for (const id of currentById.keys()) {
    if (!targetById.has(id)) plan.deletes.push(id);
  }

  for (const [id, node] of targetById) {
    const live = currentById.get(id);
    if (!live) {
      plan.inserts.push(node);
    } else if (!sameNodeFields(live, node)) {
      plan.patches.push({ id, fields: restorePatchFields(node) });
    }
  }

  return plan;
}

/**
 * Create a mirror of `sourceId` as last child of `targetParentId` (null =
 * top level). Flattens to the TRUE source; resolves the destination through
 * `trueSourceOf` (worker `planMirrorNode` / ADR 0022); refuses cycles.
 */
export function planMirrorNode(
  index: TreeIndex,
  args: {
    id: string;
    userId: string;
    sourceId: string;
    targetParentId: string | null;
    createdAt: number;
    updatedAt: number;
  },
): OutlinePlan | null {
  if (!index.byId.has(args.sourceId)) return null;

  let parentId: string | null = null;
  if (args.targetParentId !== null) {
    if (!index.byId.has(args.targetParentId)) return null;
    parentId = trueSourceOf(index, args.targetParentId);
  }

  const trueSourceId = trueSourceOf(index, args.sourceId);
  if (wouldMirrorCycle(index, trueSourceId, parentId)) return null;

  const siblings = childrenOf(index, parentId);
  const after = siblings.length ? siblings[siblings.length - 1]!.id : null;

  const plan = emptyPlan();
  plan.inserts.push(
    makeOutlineNode({
      id: args.id,
      userId: args.userId,
      parentId,
      prevSiblingId: after,
      text: index.byId.get(trueSourceId)?.text ?? "",
      mirrorOf: trueSourceId,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    }),
  );
  return plan;
}

/** Apply a plan to an in-memory node list (for unit tests / working copies). */
export function applyPlan(
  nodes: OutlineNode[],
  plan: OutlinePlan,
): OutlineNode[] {
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]));

  // deletes → patches → inserts (restore-safe; matches server commitPlan)
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

/** True when a plan would change the outline. */
function planHasWork(plan: OutlinePlan): boolean {
  return (
    plan.deletes.length > 0 ||
    plan.patches.length > 0 ||
    plan.inserts.length > 0
  );
}

/**
 * Diff `before` → `after` into one OutlinePlan. Used by multi-step planners that
 * rebuild a working copy between sibling ops (ADR 0018), then emit a single
 * watermarked mutator plan.
 */
function planFromWorkingCopy(
  before: readonly OutlineNode[],
  after: readonly OutlineNode[],
): OutlinePlan | null {
  const plan = planRestoreNodes(before, after);
  return planHasWork(plan) ? plan : null;
}

/**
 * Delete several roots (+ subtrees) in one plan. Rebuilds the working index
 * between each remove so contiguous-sibling deletes don't tear the chain
 * (port of `removeManyNodes`).
 */
export function planRemoveMany(
  nodes: readonly OutlineNode[],
  ids: readonly string[],
  updatedAt: number,
): OutlinePlan | null {
  if (ids.length === 0) return null;
  let working = [...nodes];
  for (const id of ids) {
    const step = planRemoveNode(buildTreeIndex(working), id, updatedAt);
    if (!step) continue;
    working = applyPlan(working, step);
  }
  return planFromWorkingCopy(nodes, working);
}

/**
 * Move several nodes to be last children of `targetId`, preserving order.
 * Rebuilds between each move (port of `moveManyNodes`).
 */
export function planMoveMany(
  nodes: readonly OutlineNode[],
  args: {
    targetId: string | null;
    nodeIds: readonly string[];
    updatedAt: number;
  },
): OutlinePlan | null {
  if (args.nodeIds.length === 0) return null;
  let working = [...nodes];
  const firstSiblings = childrenOf(buildTreeIndex(working), args.targetId);
  let after: string | null = firstSiblings.length
    ? firstSiblings[firstSiblings.length - 1]!.id
    : null;
  for (const id of args.nodeIds) {
    const step = planMoveNode(buildTreeIndex(working), {
      id,
      newParentId: args.targetId,
      afterSiblingId: after,
      updatedAt: args.updatedAt,
    });
    if (!step) continue;
    working = applyPlan(working, step);
    after = id;
  }
  return planFromWorkingCopy(nodes, working);
}

/**
 * Indent a contiguous sibling run under the first root's previous sibling
 * (port of `indentManyNodes`). `resolveMirror` parents into the SOURCE when
 * that previous sibling is a mirror instance.
 */
export function planIndentMany(
  nodes: readonly OutlineNode[],
  rootIds: readonly string[],
  updatedAt: number,
  resolveMirror = false,
): OutlinePlan | null {
  if (rootIds.length === 0) return null;
  let working = [...nodes];
  const index = buildTreeIndex(working);
  const targetId = index.byId.get(rootIds[0]!)?.prevSiblingId;
  if (!targetId) return null;

  if (index.byId.get(targetId)?.collapsed) {
    const expand = planSetCollapsed(
      buildTreeIndex(working),
      targetId,
      false,
      updatedAt,
    );
    if (expand) working = applyPlan(working, expand);
  }

  const live = buildTreeIndex(working);
  const target = resolveMirror ? trueSourceOf(live, targetId) : targetId;

  if (resolveMirror && target !== targetId) {
    const selected = new Set(rootIds);
    let cursor: string | null = target;
    let guard = live.byId.size + 1;
    while (cursor && guard-- > 0) {
      if (selected.has(cursor)) return null;
      cursor = live.byId.get(cursor)?.parentId ?? null;
    }
  }

  // Inline move-many against `working` so the final diff includes expand +
  // moves relative to the ORIGINAL `nodes` (not a post-expand base).
  const firstSiblings = childrenOf(buildTreeIndex(working), target);
  let after: string | null = firstSiblings.length
    ? firstSiblings[firstSiblings.length - 1]!.id
    : null;
  for (const id of rootIds) {
    const step = planMoveNode(buildTreeIndex(working), {
      id,
      newParentId: target,
      afterSiblingId: after,
      updatedAt,
    });
    if (!step) continue;
    working = applyPlan(working, step);
    after = id;
  }
  return planFromWorkingCopy(nodes, working);
}

/**
 * Outdent a contiguous sibling run one level (port of `outdentManyNodes`).
 * Rebuilds between each move so order is preserved after the former parent.
 */
export function planOutdentMany(
  nodes: readonly OutlineNode[],
  rootIds: readonly string[],
  updatedAt: number,
): OutlinePlan | null {
  if (rootIds.length === 0) return null;
  let working = [...nodes];
  const start = buildTreeIndex(working);
  const oldParentId = start.byId.get(rootIds[0]!)?.parentId;
  if (!oldParentId) return null;
  const newParentId = start.byId.get(oldParentId)?.parentId ?? null;

  let after: string = oldParentId;
  for (const id of rootIds) {
    const step = planMoveNode(buildTreeIndex(working), {
      id,
      newParentId,
      afterSiblingId: after,
      updatedAt,
    });
    if (!step) continue;
    working = applyPlan(working, step);
    after = id;
  }
  return planFromWorkingCopy(nodes, working);
}

/**
 * Daily scaffold + day (+ optional seed) inserts in ONE plan after kv claims
 * settle client-side. Each entry is already placed (`afterId` = predecessor, or
 * null for head). Skips ids already present. Port of `materializeNewDay`'s
 * node half — kv `claimMapping` stays on `/api/kv` (phase 2b).
 */
export function planMaterializeDailyNodes(
  nodes: readonly OutlineNode[],
  args: {
    userId: string;
    inserts: readonly {
      id: string;
      parentId: string | null;
      afterId: string | null;
      text: string;
    }[];
    createdAt: number;
    updatedAt: number;
  },
): OutlinePlan | null {
  if (args.inserts.length === 0) return null;
  let working = [...nodes];
  for (const ins of args.inserts) {
    if (working.some((n) => n.id === ins.id)) continue;
    const step = planInsertSibling(buildTreeIndex(working), {
      id: ins.id,
      userId: args.userId,
      parentId: ins.parentId,
      afterId: ins.afterId,
      text: ins.text,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
    if (!step) return null;
    working = applyPlan(working, step);
  }
  return planFromWorkingCopy(nodes, working);
}
