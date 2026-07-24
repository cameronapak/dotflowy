/**
 * Map classic DO `ChangeOp` batches (MCP outline-ops planners) onto an
 * OutlinePlan for Lunora `commitPlan` / applyChangeOps.
 */

import type { OutlineNode, OutlinePlan } from "./types";

import { emptyPlan } from "./types";

/** Wire ChangeOp shape without importing the Worker wire module. */
export type ChangeOpLike =
  | { op: "insert"; value: Omit<OutlineNode, "userId"> & { userId?: string } }
  | { op: "update"; value: Omit<OutlineNode, "userId"> & { userId?: string } }
  | { op: "delete"; key: string };

function toOutlineNode(
  userId: string,
  value: Omit<OutlineNode, "userId"> & { userId?: string },
): OutlineNode {
  return {
    id: value.id,
    parentId: value.parentId ?? null,
    prevSiblingId: value.prevSiblingId ?? null,
    text: value.text ?? "",
    isTask: Boolean(value.isTask),
    completed: Boolean(value.completed),
    collapsed: Boolean(value.collapsed),
    bookmarkedAt: value.bookmarkedAt ?? null,
    mirrorOf: value.mirrorOf ?? null,
    createdAt: Number(value.createdAt ?? 0),
    updatedAt: Number(value.updatedAt ?? 0),
    origin: value.origin ?? null,
    kind: value.kind === "paragraph" ? "paragraph" : null,
    userId,
  };
}

/**
 * Convert a classic `{ops}` batch into one OutlinePlan (deletes → patches →
 * inserts). Updates become full-field patches so Lunora can patch in place.
 */
export function planFromChangeOps(
  userId: string,
  ops: readonly ChangeOpLike[],
): OutlinePlan {
  const plan = emptyPlan();
  for (const op of ops) {
    if (op.op === "delete") {
      plan.deletes.push(op.key);
      continue;
    }
    const node = toOutlineNode(userId, op.value);
    if (op.op === "insert") {
      plan.inserts.push(node);
      continue;
    }
    // update — patch every field except id/userId
    const { id: _id, userId: _uid, ...fields } = node;
    plan.patches.push({ id: node.id, fields });
  }
  return plan;
}
