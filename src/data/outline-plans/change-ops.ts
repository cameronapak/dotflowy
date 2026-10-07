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
    locked: Boolean(value.locked),
    mirrorOf: value.mirrorOf ?? null,
    createdAt: Number(value.createdAt ?? 0),
    updatedAt: Number(value.updatedAt ?? 0),
    origin: value.origin ?? null,
    kind: value.kind === "paragraph" ? "paragraph" : null,
    userId,
  };
}

/**
 * The net effect of every op a batch aimed at ONE key, in stream order.
 * `replace` = a delete followed by a re-create (both halves must survive).
 */
type Net =
  | { kind: "insert"; node: OutlineNode }
  | { kind: "patch"; node: OutlineNode }
  | { kind: "delete" }
  | { kind: "replace"; node: OutlineNode };

/**
 * Fold one op into a key's running net effect.
 *
 * An `update` carries the FULL post-mutation node (see `toOutlineNode`), so
 * merging is just "the later node wins" — there are no partial field sets to
 * reconcile.
 */
function foldOp(
  prev: Net | undefined,
  op: "insert" | "update" | "delete",
  node: OutlineNode | null,
): Net | null {
  if (op === "delete") {
    // An insert this same batch made means the row never existed before it, so
    // insert-then-delete is a net no-op — NOT a delete of some older row.
    if (prev?.kind === "insert") return null;
    return { kind: "delete" };
  }
  const next = node!;
  if (!prev) return { kind: op === "insert" ? "insert" : "patch", node: next };
  // Re-created after a delete in the same batch: the delete still has to run
  // (it's clearing a pre-existing row), then the row comes back.
  if (prev.kind === "delete" || prev.kind === "replace")
    return { kind: "replace", node: next };
  // An insert stays an insert no matter how many updates follow it — folding
  // the update into the inserted node is what keeps the update from being
  // applied to a row that doesn't exist yet.
  if (prev.kind === "insert") return { kind: "insert", node: next };
  return { kind: op === "insert" ? "insert" : "patch", node: next };
}

/**
 * Convert a classic `{ops}` batch into one OutlinePlan (deletes → patches →
 * inserts). Updates become full-field patches so Lunora can patch in place.
 *
 * Ops are COALESCED PER KEY first, because the plan's three buckets are applied
 * in a fixed order (`applyPlan` / server `commitPlan`) that does not preserve
 * stream order across buckets. Emitting a batch's ops verbatim would misapply
 * any key touched twice: `insert n1` + `update n1` would run the patch before
 * the row exists (update silently lost), and `insert n1` + `delete n1` would
 * run the delete first and leave the node alive.
 *
 * Key order follows FIRST appearance in the stream, so the sibling chains the
 * MCP planners wire by construction survive the fold.
 */
export function planFromChangeOps(
  userId: string,
  ops: readonly ChangeOpLike[],
): OutlinePlan {
  const net = new Map<string, Net>();
  for (const op of ops) {
    const key = op.op === "delete" ? op.key : op.value.id;
    const node = op.op === "delete" ? null : toOutlineNode(userId, op.value);
    const folded = foldOp(net.get(key), op.op, node);
    if (folded === null) net.delete(key);
    else net.set(key, folded);
  }

  const plan = emptyPlan();
  for (const [key, entry] of net) {
    if (entry.kind === "delete") {
      plan.deletes.push(key);
      continue;
    }
    if (entry.kind === "replace") plan.deletes.push(key);
    if (entry.kind === "patch") {
      // patch every field except id/userId
      const { id: _id, userId: _uid, ...fields } = entry.node;
      plan.patches.push({ id: entry.node.id, fields });
      continue;
    }
    plan.inserts.push(entry.node);
  }
  return plan;
}
