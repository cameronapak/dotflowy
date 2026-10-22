import type { ChangeOp, Node } from "../src/data/wire-schema";

import {
  buildTreeIndex,
  childrenOf,
  isNodeInheritedLocked,
  trueSourceOf,
} from "../src/data/tree";

export interface LockViolation {
  reason: string;
}

export interface NodePatch {
  id: string;
  changes: Partial<Node>;
}

type StableNode = Omit<Node, "locked" | "updatedAt">;
type Signature = string | number | boolean | null | Signature[];

function applyOps(nodes: readonly Node[], ops: readonly ChangeOp[]): Node[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const op of ops) {
    if (op.op === "delete") byId.delete(op.key);
    else byId.set(op.value.id, op.value);
  }
  return [...byId.values()];
}

function withoutLockState(node: Node): StableNode {
  const { locked: _locked, updatedAt: _updatedAt, ...stable } = node;
  return stable;
}

function lockOnlyChange(
  before: readonly Node[],
  after: readonly Node[],
): boolean {
  if (before.length !== after.length) return false;
  const afterById = new Map(after.map((node) => [node.id, node]));
  return before.every((node) => {
    const next = afterById.get(node.id);
    return (
      !!next &&
      JSON.stringify(withoutLockState(node)) ===
        JSON.stringify(withoutLockState(next))
    );
  });
}

/** A lock compares the rendered content tree, not raw linked-list fields. That
 * permits relocating the root intact while rejecting edits, insertion,
 * extraction, deletion, and reordering inside it. */
function subtreeSignature(nodes: readonly Node[], rootId: string): string {
  const index = buildTreeIndex([...nodes]);
  const walk = (
    instanceId: string,
    sources: ReadonlySet<string>,
  ): Signature => {
    const instance = index.byId.get(instanceId);
    if (!instance) return ["missing", instanceId];
    const sourceId = trueSourceOf(index, instanceId);
    const content = index.byId.get(sourceId);
    if (!content) return ["missing-source", instanceId, sourceId];
    const authored: Signature[] = [
      content.id,
      content.text,
      content.isTask,
      content.completed,
      content.kind,
      content.origin,
      content.createdAt,
    ];
    if (sources.has(sourceId)) return [instanceId, sourceId, authored, "cycle"];
    const nextSources = new Set(sources).add(sourceId);
    return [
      instanceId,
      sourceId,
      authored,
      childrenOf(index, sourceId).map((child) => walk(child.id, nextSources)),
    ];
  };
  return JSON.stringify(walk(rootId, new Set()));
}

/** Validate one ordinary write against the pre-write direct locks. Recovery
 * intentionally bypasses this function. Lock transitions are accepted only on
 * the editor-authorized path and only as otherwise lock-only batches, so an
 * unlock cannot smuggle a content edit into the same atomic commit. */
export function validateLockedWrite(
  before: readonly Node[],
  ops: readonly ChangeOp[],
  allowLockChanges = false,
): LockViolation | null {
  if (ops.length === 0) return null;
  const after = applyOps(before, ops);
  const beforeById = new Map(before.map((node) => [node.id, node]));
  const afterById = new Map(after.map((node) => [node.id, node]));
  const deletedIds = new Set(
    ops.filter((op) => op.op === "delete").map((op) => op.key),
  );
  const changedLocks = new Set<string>();
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const previous = beforeById.get(id);
    const next = afterById.get(id);
    if (
      next &&
      ((!previous && next.locked) ||
        (!!previous && previous.locked !== next.locked))
    )
      changedLocks.add(id);
  }
  if (changedLocks.size > 0) {
    if (!allowLockChanges)
      return { reason: "Only the editor can change node locks." };
    if (!lockOnlyChange(before, after))
      return { reason: "Lock changes must be committed separately." };
    for (const id of changedLocks) {
      if (afterById.get(id)?.mirrorOf)
        return { reason: "A mirror lock must be stored on its source." };
      const beforeNode = beforeById.get(id);
      if (beforeNode && isNodeInheritedLocked(buildTreeIndex([...before]), id))
        return {
          reason:
            "An inherited lock must be removed before changing this lock.",
        };
    }
    return null;
  }

  const roots = before.filter((node) => node.locked);
  for (const root of roots) {
    const sourceId = root.mirrorOf ?? root.id;
    if (!afterById.has(sourceId))
      return { reason: "A locked node cannot be deleted." };
  }

  const beforeIndex = buildTreeIndex([...before]);
  // Preserve physical ancestry for every effectively locked source, including
  // sources reached through a mirror inside a locked subtree.
  for (const sourceId of beforeIndex.lockedContentIds) {
    const seenAncestors = new Set<string>();
    let parentId = beforeById.get(sourceId)?.parentId ?? null;
    while (parentId && !seenAncestors.has(parentId)) {
      if (deletedIds.has(parentId))
        return { reason: "An ancestor of a locked node cannot be deleted." };
      seenAncestors.add(parentId);
      parentId = beforeById.get(parentId)?.parentId ?? null;
    }
  }

  for (const root of roots) {
    const sourceId = root.mirrorOf ?? root.id;
    if (
      subtreeSignature(before, sourceId) !== subtreeSignature(after, sourceId)
    ) {
      return { reason: "Locked content cannot be changed." };
    }
  }
  return null;
}

/** Validate PATCH semantics exactly as SQLite applies them: repeated ids merge
 * cumulatively in request order rather than each starting from the original. */
export function validateLockedPatches(
  before: readonly Node[],
  patches: readonly NodePatch[],
  allowLockChanges = false,
): LockViolation | null {
  const byId = new Map(before.map((node) => [node.id, node]));
  const ops: ChangeOp[] = [];
  for (const patch of patches) {
    const node = byId.get(patch.id);
    if (!node) continue;
    const value = { ...node, ...patch.changes };
    byId.set(patch.id, value);
    ops.push({ op: "update", value });
  }
  return validateLockedWrite(before, ops, allowLockChanges);
}
