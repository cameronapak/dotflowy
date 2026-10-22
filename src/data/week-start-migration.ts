import type { ChangeOp, Node } from "./wire-schema";

import {
  PROTECTED_SCAFFOLD_KINDS,
  addDays,
  compareScaffoldKeys,
  dayKeyToScaffoldChain,
  dayKeyToWeekKey,
  scaffoldKeyKind,
  scaffoldLabel,
  weekKeyToStartDay,
  type WeekStart,
} from "./date-links";
import { buildTreeIndex, childrenOf } from "./tree";

export interface DailyIndexRow {
  key: string;
  nodeId: string;
}

export interface WeekStartMigrationPlan {
  ops: ChangeOp[];
  upserts: DailyIndexRow[];
  deletes: string[];
}

type MutableNode = { -readonly [K in keyof Node]: Node[K] };

function nodeChanged(a: Node, b: Node): boolean {
  return (
    a.parentId !== b.parentId ||
    a.prevSiblingId !== b.prevSiblingId ||
    a.text !== b.text ||
    a.updatedAt !== b.updatedAt
  );
}

function newScaffoldNode(
  id: string,
  parentId: string,
  text: string,
  now: number,
): MutableNode {
  return {
    id,
    parentId,
    prevSiblingId: null,
    text,
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    locked: false,
    mirrorOf: null,
    createdAt: now,
    updatedAt: now,
    origin: null,
    kind: null,
  };
}

/** True only when a node's complete mapped-scaffold ancestry reaches Daily. */
function inDailyScaffold(
  node: Node,
  containerId: string,
  nodes: ReadonlyMap<string, Node>,
  keyByNodeId: ReadonlyMap<string, string>,
): boolean {
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId) {
    if (parentId === containerId) return true;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const key = keyByNodeId.get(parentId);
    const kind = key ? scaffoldKeyKind(key) : null;
    if (!kind || !PROTECTED_SCAFFOLD_KINDS.has(kind)) return false;
    parentId = nodes.get(parentId)?.parentId ?? null;
  }
  return false;
}

/**
 * Plan the complete node + daily-index rewrite for an account Week-start change.
 * Existing Week nodes follow the target week containing their fourth day, which
 * is the unique six-day overlap for a one-day Sunday/Monday boundary shift.
 */
export function planWeekStartMigration(
  sourceNodes: readonly Node[],
  rows: readonly DailyIndexRow[],
  target: WeekStart,
  now: number,
  createId: () => string,
): WeekStartMigrationPlan {
  const original = buildTreeIndex([...sourceNodes]);
  const originalById = original.byId;
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const keyByNodeId = new Map(rows.map((row) => [row.nodeId, row.key]));
  const containerId = rowByKey.get("container")?.nodeId;
  if (!containerId || !originalById.has(containerId)) {
    return { ops: [], upserts: [], deletes: [] };
  }

  const finalById = new Map<string, MutableNode>(
    sourceNodes.map((node) => [node.id, { ...node }] as const),
  );
  const mapping = new Map(rows.map((row) => [row.key, row.nodeId]));
  const upsertKeys = new Set<string>();
  const deleteKeys = new Set<string>();
  const touchedParents = new Set<string>();

  // A scaffold claim can outlive a client that lost a calendar race before its
  // node batch committed. It has no authored content to preserve, and retaining
  // it can make a later migration mistake the abandoned key for a real Week.
  for (const row of rows) {
    const kind = scaffoldKeyKind(row.key);
    if (kind !== "year" && kind !== "month" && kind !== "week") continue;
    if (originalById.has(row.nodeId)) continue;
    mapping.delete(row.key);
    deleteKeys.add(row.key);
    keyByNodeId.delete(row.nodeId);
  }

  const scopedWeekRows = rows.filter((row) => {
    if (scaffoldKeyKind(row.key) !== "week") return false;
    const node = originalById.get(row.nodeId);
    return node
      ? inDailyScaffold(node, containerId, originalById, keyByNodeId)
      : false;
  });

  // Reuse each old Week node for the new Calendar week sharing six days.
  for (const row of scopedWeekRows) {
    const start = weekKeyToStartDay(row.key);
    const node = finalById.get(row.nodeId);
    if (!start || !node) continue;
    const targetKey = dayKeyToWeekKey(
      // The fourth day belongs to the six-day-overlap target in both directions.
      addDays(start, 3),
      target,
    );
    if (!targetKey) continue;
    if (targetKey === row.key) continue;
    const occupied = mapping.get(targetKey);
    if (occupied && occupied !== row.nodeId) {
      throw new Error(`week mapping ${targetKey} is already occupied`);
    }
    mapping.delete(row.key);
    mapping.set(targetKey, row.nodeId);
    deleteKeys.add(row.key);
    upsertKeys.add(targetKey);
    keyByNodeId.set(row.nodeId, targetKey);
  }

  const ensureMapping = (key: string): string => {
    const existing = mapping.get(key);
    if (existing) {
      const existingNode = originalById.get(existing);
      if (
        existingNode &&
        !inDailyScaffold(existingNode, containerId, originalById, keyByNodeId)
      ) {
        throw new Error(`${scaffoldKeyKind(key)} mapping ${key} was relocated`);
      }
      return existing;
    }
    const id = createId();
    mapping.set(key, id);
    keyByNodeId.set(id, key);
    upsertKeys.add(key);
    return id;
  };

  const scopedDays: Array<{ node: Node; dayKey: string }> = [];
  for (const row of rows) {
    if (scaffoldKeyKind(row.key) !== "day") continue;
    const node = originalById.get(row.nodeId);
    if (!node) continue;
    // A top-level day is a valid user relocation. Only a dangling non-null
    // parent is an orphan that migration may recover into Daily.
    const orphan = node.parentId !== null && !originalById.has(node.parentId);
    if (
      !orphan &&
      !inDailyScaffold(node, containerId, originalById, keyByNodeId)
    ) {
      continue;
    }
    scopedDays.push({ node, dayKey: row.key });
  }

  const requiredWeekKeys = new Set<string>();
  for (const { dayKey } of scopedDays) {
    const weekKey = dayKeyToWeekKey(dayKey, target);
    if (weekKey) requiredWeekKeys.add(weekKey);
  }
  for (const row of scopedWeekRows) {
    const key = keyByNodeId.get(row.nodeId);
    if (key && scaffoldKeyKind(key) === "week") requiredWeekKeys.add(key);
  }

  for (const weekKey of requiredWeekKeys) {
    const chainStart = weekKeyToStartDay(weekKey);
    const chain = chainStart ? dayKeyToScaffoldChain(chainStart, target) : null;
    if (!chain) continue;
    const yearId = ensureMapping(chain.yearKey);
    const monthId = ensureMapping(chain.monthKey);
    const weekId = ensureMapping(chain.weekKey);

    if (!finalById.has(yearId)) {
      finalById.set(
        yearId,
        newScaffoldNode(yearId, containerId, scaffoldLabel(chain.yearKey), now),
      );
    }
    if (!finalById.has(monthId)) {
      finalById.set(
        monthId,
        newScaffoldNode(monthId, yearId, scaffoldLabel(chain.monthKey), now),
      );
    }
    if (!finalById.has(weekId)) {
      finalById.set(
        weekId,
        newScaffoldNode(weekId, monthId, scaffoldLabel(chain.weekKey), now),
      );
    }

    const year = finalById.get(yearId)!;
    const month = finalById.get(monthId)!;
    const week = finalById.get(weekId)!;
    for (const [node, parentId, text] of [
      [year, containerId, scaffoldLabel(chain.yearKey)],
      [month, yearId, scaffoldLabel(chain.monthKey)],
      [week, monthId, scaffoldLabel(chain.weekKey)],
    ] as const) {
      let changed = false;
      if (node.parentId !== parentId) {
        if (node.parentId) touchedParents.add(node.parentId);
        node.parentId = parentId;
        changed = true;
      }
      if (node.text !== text) {
        node.text = text;
        changed = true;
      }
      if (changed) node.updatedAt = now;
      touchedParents.add(parentId);
    }
  }

  for (const { node: originalDay, dayKey } of scopedDays) {
    const weekKey = dayKeyToWeekKey(dayKey, target);
    const weekId = weekKey ? mapping.get(weekKey) : null;
    const day = finalById.get(originalDay.id);
    if (!weekId || !day) continue;
    if (day.parentId !== weekId) {
      if (day.parentId) touchedParents.add(day.parentId);
      day.parentId = weekId;
      day.updatedAt = now;
    }
    touchedParents.add(weekId);
  }

  // Remove only scaffold that became genuinely empty after week moves. User
  // notes directly under a Month or Year keep that scaffold alive. Months run
  // first so their removal can make an obsolete Year empty in the same pass.
  for (const kind of ["month", "year"] as const) {
    for (const row of rows) {
      if (scaffoldKeyKind(row.key) !== kind) continue;
      const originalNode = originalById.get(row.nodeId);
      const node = finalById.get(row.nodeId);
      if (
        !originalNode ||
        !node ||
        !inDailyScaffold(
          originalNode,
          containerId,
          originalById,
          keyByNodeId,
        ) ||
        [...finalById.values()].some(
          (candidate) => candidate.parentId === node.id,
        )
      ) {
        continue;
      }
      finalById.delete(node.id);
      if (mapping.get(row.key) === node.id) mapping.delete(row.key);
      deleteKeys.add(row.key);
      if (node.parentId) touchedParents.add(node.parentId);
    }
  }

  // Rebuild linked sibling chains for every parent that gained or lost a child.
  const finalNodes = [...finalById.values()];
  for (const parentId of touchedParents) {
    const parentKey = keyByNodeId.get(parentId) ?? null;
    const parentKind = parentKey ? scaffoldKeyKind(parentKey) : null;
    const childKind =
      parentId === containerId
        ? "year"
        : parentKind === "year"
          ? "month"
          : parentKind === "month"
            ? "week"
            : parentKind === "week"
              ? "day"
              : undefined;
    const originalOrder = childrenOf(original, parentId).map((node) => node.id);
    const finalChildren = finalNodes.filter(
      (node) => node.parentId === parentId,
    );
    const finalIds = new Set(finalChildren.map((node) => node.id));
    const retained = originalOrder.filter((id) => finalIds.has(id));
    for (const child of finalChildren) {
      if (!retained.includes(child.id)) retained.push(child.id);
    }
    let ordered = retained;
    if (childKind) {
      const organized = finalChildren
        .filter((node) => {
          const key = keyByNodeId.get(node.id);
          return key ? scaffoldKeyKind(key) === childKind : false;
        })
        .sort((a, b) =>
          compareScaffoldKeys(keyByNodeId.get(a.id)!, keyByNodeId.get(b.id)!),
        )
        .map((node) => node.id);
      const organizedSet = new Set(organized);
      const firstOld = ordered.findIndex((id) => organizedSet.has(id));
      const without = ordered.filter((id) => !organizedSet.has(id));
      const insertion =
        firstOld < 0
          ? without.length
          : ordered.slice(0, firstOld).filter((id) => !organizedSet.has(id))
              .length;
      ordered = [
        ...without.slice(0, insertion),
        ...organized,
        ...without.slice(insertion),
      ];
    }
    let previous: string | null = null;
    for (const id of ordered) {
      const child = finalById.get(id);
      if (!child) continue;
      if (child.prevSiblingId !== previous) {
        child.prevSiblingId = previous;
        child.updatedAt = now;
      }
      previous = id;
    }
  }

  const ops: ChangeOp[] = [];
  for (const node of sourceNodes) {
    if (!finalById.has(node.id)) ops.push({ op: "delete", key: node.id });
  }
  for (const node of finalById.values()) {
    const before = originalById.get(node.id);
    if (!before) ops.push({ op: "insert", value: node });
    else if (nodeChanged(before, node)) ops.push({ op: "update", value: node });
  }

  const upserts = [...upsertKeys]
    .map((key) => ({ key, nodeId: mapping.get(key)! }))
    .sort((a, b) => compareScaffoldKeys(a.key, b.key));
  return {
    ops,
    upserts,
    deletes: [...deleteKeys].filter((key) => !mapping.has(key)),
  };
}
