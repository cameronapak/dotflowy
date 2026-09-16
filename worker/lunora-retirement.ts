import { Schema } from "effect";

import type { Node } from "../src/data/wire-schema";

import { NodeSchema } from "../src/data/wire-schema";
import { OutlineSnapshotSchema, type OutlineSnapshot } from "./backup";

export const RETIREMENT_SNAPSHOT_VERSION = 1;
export const RETIREMENT_PREFIX = "lunora-retirement";

const OwnedRow = { userId: Schema.String };

export const LunoraNodeSchema = Schema.Struct({
  ...NodeSchema.fields,
  ...OwnedRow,
});
export type LunoraNode = Schema.Schema.Type<typeof LunoraNodeSchema>;

export const LunoraRetirementSnapshotSchema = Schema.Struct({
  version: Schema.Number,
  exportedAt: Schema.Number,
  userId: Schema.String,
  nodes: Schema.Array(LunoraNodeSchema),
  dailyIndex: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      nodeId: Schema.String,
      touchedAt: Schema.Number,
      ...OwnedRow,
    }),
  ),
  tagColors: Schema.Array(
    Schema.Struct({
      tag: Schema.String,
      color: Schema.String,
      ...OwnedRow,
    }),
  ),
  savedQueries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      query: Schema.String,
      createdAt: Schema.Number,
      ...OwnedRow,
    }),
  ),
  migrateState: Schema.Array(
    Schema.Struct({
      nodesAt: Schema.NullOr(Schema.Number),
      kvAt: Schema.NullOr(Schema.Number),
      ...OwnedRow,
    }),
  ),
});
export type LunoraRetirementSnapshot = Schema.Schema.Type<
  typeof LunoraRetirementSnapshotSchema
>;

export type RetirementClassification =
  | "eligible"
  | "already-classic"
  | "backend-conflict"
  | "incomplete"
  | "invalid"
  | "classic-invalid";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface ClassicTarget {
  nodes: Node[];
  kv: Array<OutlineSnapshot["kv"][number]>;
}

export interface RetirementSnapshotCounts {
  nodes: number;
  dailyIndex: number;
  tagColors: number;
  savedQueries: number;
}

const ClassicDailyValueSchema = Schema.Struct({
  key: Schema.String,
  nodeId: Schema.String,
});
const ClassicTagColorValueSchema = Schema.Struct({
  tag: Schema.String,
  color: Schema.String,
});
const ClassicSavedQueryValueSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  query: Schema.String,
  createdAt: Schema.Number,
});
const LunoraPreferenceValueSchema = Schema.Struct({
  enabled: Schema.Boolean,
});

function duplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/** Validate the complete ordered-tree representation, including roots. */
export function validateNodeGraph(nodes: readonly Node[]): ValidationResult {
  const duplicateId = duplicate(nodes.map((node) => node.id));
  if (duplicateId)
    return { ok: false, reason: `duplicate node id ${duplicateId}` };

  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) {
      return { ok: false, reason: `node ${node.id} has missing parent` };
    }
    if (node.prevSiblingId !== null && !byId.has(node.prevSiblingId)) {
      return {
        ok: false,
        reason: `node ${node.id} has missing previous sibling`,
      };
    }
    if (node.mirrorOf !== null && !byId.has(node.mirrorOf)) {
      return { ok: false, reason: `node ${node.id} has missing mirror source` };
    }
  }

  for (const node of nodes) {
    const ancestors = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) {
        return { ok: false, reason: `parent cycle at node ${node.id}` };
      }
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }

  const groups = new Map<string | null, Node[]>();
  for (const node of nodes) {
    const siblings = groups.get(node.parentId) ?? [];
    siblings.push(node);
    groups.set(node.parentId, siblings);
  }
  for (const [parentId, siblings] of groups) {
    const heads = siblings.filter((node) => node.prevSiblingId === null);
    if (heads.length !== 1) {
      return {
        ok: false,
        reason: `parent ${parentId ?? "root"} has ${heads.length} sibling heads`,
      };
    }
    const nextByPrevious = new Map<string, Node>();
    for (const node of siblings) {
      if (node.prevSiblingId === null) continue;
      const previous = byId.get(node.prevSiblingId);
      if (previous?.parentId !== parentId) {
        return { ok: false, reason: `node ${node.id} crosses sibling chains` };
      }
      if (nextByPrevious.has(node.prevSiblingId)) {
        return {
          ok: false,
          reason: `sibling ${node.prevSiblingId} has multiple successors`,
        };
      }
      nextByPrevious.set(node.prevSiblingId, node);
    }
    let count = 0;
    let current: Node | undefined = heads[0];
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.id)) {
        return { ok: false, reason: `sibling cycle at node ${current.id}` };
      }
      visited.add(current.id);
      count++;
      current = nextByPrevious.get(current.id);
    }
    if (count !== siblings.length) {
      return {
        ok: false,
        reason: `parent ${parentId ?? "root"} has an incomplete sibling chain`,
      };
    }
  }
  return { ok: true };
}

export function validateClassicSnapshot(
  raw: OutlineSnapshot,
): ValidationResult {
  const decoded = Schema.decodeUnknownOption(OutlineSnapshotSchema)(raw);
  if (decoded._tag === "None") {
    return { ok: false, reason: "classic snapshot schema rejected" };
  }
  const graph = validateNodeGraph(decoded.value.nodes);
  if (!graph.ok) return graph;
  const naturalKeys = decoded.value.kv.map(
    (row) => `${row.collection}\u0000${row.key}`,
  );
  const duplicateKey = duplicate(naturalKeys);
  if (duplicateKey) {
    return { ok: false, reason: "classic snapshot has duplicate kv keys" };
  }
  const nodeIds = new Set(decoded.value.nodes.map((node) => node.id));
  for (const row of decoded.value.kv) {
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      return {
        ok: false,
        reason: `classic ${row.collection}/${row.key} value is not JSON`,
      };
    }
    if (row.collection === "daily-index") {
      const decodedValue = Schema.decodeUnknownOption(ClassicDailyValueSchema)(
        value,
      );
      if (
        decodedValue._tag === "None" ||
        decodedValue.value.key !== row.key ||
        !nodeIds.has(decodedValue.value.nodeId)
      ) {
        return { ok: false, reason: `classic daily key ${row.key} is invalid` };
      }
    }
    if (row.collection === "tag-colors") {
      const decodedValue = Schema.decodeUnknownOption(
        ClassicTagColorValueSchema,
      )(value);
      if (decodedValue._tag === "None" || decodedValue.value.tag !== row.key) {
        return { ok: false, reason: `classic tag color ${row.key} is invalid` };
      }
    }
    if (row.collection === "saved-queries") {
      const decodedValue = Schema.decodeUnknownOption(
        ClassicSavedQueryValueSchema,
      )(value);
      if (decodedValue._tag === "None" || decodedValue.value.id !== row.key) {
        return {
          ok: false,
          reason: `classic saved query ${row.key} is invalid`,
        };
      }
    }
  }
  return { ok: true };
}

export function validateLunoraSnapshot(
  raw: LunoraRetirementSnapshot,
  expectedUserId: string,
): ValidationResult {
  const decoded = Schema.decodeUnknownOption(LunoraRetirementSnapshotSchema)(
    raw,
  );
  if (decoded._tag === "None") {
    return { ok: false, reason: "Lunora snapshot schema rejected" };
  }
  const snapshot = decoded.value;
  if (snapshot.version !== RETIREMENT_SNAPSHOT_VERSION) {
    return {
      ok: false,
      reason: `unknown Lunora snapshot version ${snapshot.version}`,
    };
  }
  if (snapshot.userId !== expectedUserId) {
    return { ok: false, reason: "Lunora snapshot user does not match target" };
  }
  for (const rows of [
    snapshot.nodes,
    snapshot.dailyIndex,
    snapshot.tagColors,
    snapshot.savedQueries,
    snapshot.migrateState,
  ]) {
    if (rows.some((row) => row.userId !== expectedUserId)) {
      return { ok: false, reason: "Lunora row ownership mismatch" };
    }
  }
  if (snapshot.nodes.length === 0) {
    return { ok: false, reason: "Lunora snapshot has no nodes" };
  }
  if (
    snapshot.migrateState.length !== 1 ||
    snapshot.migrateState[0]?.nodesAt === null ||
    snapshot.migrateState[0]?.kvAt === null
  ) {
    return { ok: false, reason: "Lunora migrate watermarks are incomplete" };
  }
  const nodeGraph = validateNodeGraph(snapshot.nodes);
  if (!nodeGraph.ok) return nodeGraph;

  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const duplicateDaily = duplicate(snapshot.dailyIndex.map((row) => row.key));
  if (duplicateDaily)
    return { ok: false, reason: `duplicate daily key ${duplicateDaily}` };
  const duplicateTag = duplicate(snapshot.tagColors.map((row) => row.tag));
  if (duplicateTag)
    return { ok: false, reason: `duplicate tag ${duplicateTag}` };
  const duplicateQuery = duplicate(snapshot.savedQueries.map((row) => row.id));
  if (duplicateQuery)
    return { ok: false, reason: `duplicate saved query id ${duplicateQuery}` };
  for (const row of snapshot.dailyIndex) {
    if (!nodeIds.has(row.nodeId)) {
      return {
        ok: false,
        reason: `daily key ${row.key} references a missing node`,
      };
    }
  }
  return { ok: true };
}

export function classifyRetirement(input: {
  preferenceEnabled: boolean;
  classic: ValidationResult;
  lunora: ValidationResult;
  lunoraNodeCount: number;
}): RetirementClassification {
  if (!input.classic.ok) return "classic-invalid";
  if (!input.preferenceEnabled) {
    return input.lunoraNodeCount > 0 ? "backend-conflict" : "already-classic";
  }
  if (!input.lunora.ok) {
    return input.lunoraNodeCount === 0 ? "incomplete" : "invalid";
  }
  return "eligible";
}

export function retirementSnapshotKey(
  userId: string,
  migrationId: string,
  backend: "classic" | "lunora",
): string {
  return `${RETIREMENT_PREFIX}/${userId}/${migrationId}/${backend}.json`;
}

export async function sha256Hex(
  bytes: ArrayBuffer | Uint8Array,
): Promise<string> {
  const source =
    bytes instanceof Uint8Array ? new Uint8Array(bytes).buffer : bytes;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function buildClassicTarget(
  classic: OutlineSnapshot,
  lunora: LunoraRetirementSnapshot,
  now: number,
): ClassicTarget {
  const shared = new Set(["daily-index", "tag-colors", "saved-queries"]);
  const kv = disableLunoraPreference(
    classic.kv.filter((row) => !shared.has(row.collection)),
    now,
  );
  for (const row of lunora.dailyIndex) {
    kv.push({
      collection: "daily-index",
      key: row.key,
      value: JSON.stringify({ key: row.key, nodeId: row.nodeId }),
      updatedAt: row.touchedAt,
    });
  }
  for (const row of lunora.tagColors) {
    kv.push({
      collection: "tag-colors",
      key: row.tag,
      value: JSON.stringify({ tag: row.tag, color: row.color }),
      updatedAt: now,
    });
  }
  for (const row of lunora.savedQueries) {
    kv.push({
      collection: "saved-queries",
      key: row.id,
      value: JSON.stringify({
        id: row.id,
        name: row.name,
        query: row.query,
        createdAt: row.createdAt,
      }),
      updatedAt: now,
    });
  }
  return {
    nodes: lunora.nodes.map(({ userId: _userId, ...node }) => node),
    kv,
  };
}

/** Keep routing on classic whenever Lunora is retired, including restore. */
export function disableLunoraPreference(
  rows: OutlineSnapshot["kv"],
  now: number,
): Array<OutlineSnapshot["kv"][number]> {
  const kv = [...rows];
  const prefIndex = kv.findIndex(
    (row) => row.collection === "account-prefs" && row.key === "lunora-beta",
  );
  const pref = {
    collection: "account-prefs",
    key: "lunora-beta",
    value: JSON.stringify({ id: "lunora-beta", enabled: false }),
    updatedAt: now,
  };
  if (prefIndex >= 0) kv[prefIndex] = pref;
  else kv.push(pref);
  return kv;
}

export function snapshotCounts(
  snapshot: LunoraRetirementSnapshot,
): RetirementSnapshotCounts {
  return {
    nodes: snapshot.nodes.length,
    dailyIndex: snapshot.dailyIndex.length,
    tagColors: snapshot.tagColors.length,
    savedQueries: snapshot.savedQueries.length,
  };
}

export function isLunoraPreferenceEnabled(snapshot: OutlineSnapshot): boolean {
  const row = snapshot.kv.find(
    (item) => item.collection === "account-prefs" && item.key === "lunora-beta",
  );
  if (!row) return false;
  try {
    return Schema.decodeUnknownSync(LunoraPreferenceValueSchema)(
      JSON.parse(row.value),
    ).enabled;
  } catch {
    return false;
  }
}

export function classicSnapshotsEquivalent(
  left: Pick<OutlineSnapshot, "nodes" | "kv">,
  right: Pick<OutlineSnapshot, "nodes" | "kv">,
): boolean {
  const normalize = (snapshot: Pick<OutlineSnapshot, "nodes" | "kv">) => ({
    nodes: [...snapshot.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    kv: [...snapshot.kv].sort((a, b) =>
      `${a.collection}\u0000${a.key}`.localeCompare(
        `${b.collection}\u0000${b.key}`,
      ),
    ),
  });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
