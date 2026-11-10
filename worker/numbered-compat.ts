import type { ChangeOp, Node, ServerMessage } from "../src/data/wire-schema";

/** Old closed-enum readers see a bullet, without changing canonical storage. */
export function legacyNumberedNode<T extends { kind: Node["kind"] }>(
  node: T,
): T {
  return node.kind === "numbered" ? { ...node, kind: null } : node;
}

function legacyOps(ops: readonly ChangeOp[]): ChangeOp[] {
  return ops.map((op) =>
    op.op === "delete" ? op : { ...op, value: legacyNumberedNode(op.value) },
  );
}

export function legacyNumberedFrame(frame: ServerMessage): ServerMessage {
  switch (frame.type) {
    case "snapshot":
      return { ...frame, nodes: frame.nodes.map(legacyNumberedNode) };
    case "resume":
      return {
        ...frame,
        changes: frame.changes.map((change) => ({
          ...change,
          ops: legacyOps(change.ops),
        })),
      };
    case "change":
      return { ...frame, ops: legacyOps(frame.ops) };
  }
}

/** Legacy full-node writes and undo cannot distinguish a numbered row from a
 * bullet. Reject their whole transaction instead of acknowledging Kind loss. */
export function touchesNumbered(
  current: readonly Node[],
  ids: readonly string[],
): boolean {
  const affected = new Set(ids);
  return current.some(
    (node) => node.kind === "numbered" && affected.has(node.id),
  );
}
