import { Schema } from "effect";

import type { Node } from "../src/data/wire-schema";

import { NodeSchema } from "../src/data/wire-schema";
import { OutlineSnapshotSchema, type OutlineSnapshot } from "./backup";

export const RETIREMENT_SNAPSHOT_VERSION = 1;
export const RETIREMENT_PREFIX = "lunora-retirement";

const OwnedRow = { userId: Schema.String };
const { id: _nodeId, ...NodeSourceFields } = NodeSchema.fields;

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

/** Exact Lunora documents. JsonObject validates JSON while retaining every key. */
export const LunoraRawDocumentSchema = Schema.JsonObject;
export type LunoraRawDocument = Schema.Schema.Type<
  typeof LunoraRawDocumentSchema
>;

export const LunoraRetirementArchiveSchema = Schema.Struct({
  version: Schema.Literal(1),
  userId: Schema.String,
  exportedAt: Schema.Number,
  snapshot: LunoraRetirementSnapshotSchema,
  raw: Schema.Struct({
    nodes: Schema.Array(LunoraRawDocumentSchema),
    dailyIndex: Schema.Array(LunoraRawDocumentSchema),
    tagColors: Schema.Array(LunoraRawDocumentSchema),
    savedQueries: Schema.Array(LunoraRawDocumentSchema),
    migrateState: Schema.Array(LunoraRawDocumentSchema),
  }),
});
export type LunoraRetirementArchive = Schema.Schema.Type<
  typeof LunoraRetirementArchiveSchema
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
      // Daily mappings are retained claims, not node-graph edges. Deletion or
      // undo can remove the node; daily get-or-create reuses its claimed id.
      if (decodedValue._tag === "None" || decodedValue.value.key !== row.key) {
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

  // As on classic, daily claims can outlive their nodes. Keep every claim in
  // the export and restored target, including ids that will be materialized later.
  const duplicateDaily = duplicate(snapshot.dailyIndex.map((row) => row.key));
  if (duplicateDaily)
    return { ok: false, reason: `duplicate daily key ${duplicateDaily}` };
  const duplicateTag = duplicate(snapshot.tagColors.map((row) => row.tag));
  if (duplicateTag)
    return { ok: false, reason: `duplicate tag ${duplicateTag}` };
  const duplicateQuery = duplicate(snapshot.savedQueries.map((row) => row.id));
  if (duplicateQuery)
    return { ok: false, reason: `duplicate saved query id ${duplicateQuery}` };
  return { ok: true };
}

/** Validate archive authority and raw/projected identity without validating raw graph edges. */
export function validateLunoraRetirementArchive(
  value: LunoraRetirementArchive,
  expectedUserId: string,
): ValidationResult {
  const decoded = Schema.decodeUnknownOption(LunoraRetirementArchiveSchema)(
    value,
  );
  if (decoded._tag === "None") {
    return { ok: false, reason: "Lunora retirement archive schema rejected" };
  }
  const archive = decoded.value;
  if (
    archive.userId !== expectedUserId ||
    archive.snapshot.userId !== expectedUserId
  ) {
    return { ok: false, reason: "Lunora archive user does not match target" };
  }
  if (archive.snapshot.exportedAt !== archive.exportedAt) {
    return { ok: false, reason: "Lunora archive export timestamps differ" };
  }
  if (archive.snapshot.version !== archive.version) {
    return { ok: false, reason: "Lunora archive versions differ" };
  }
  for (const rows of [
    archive.snapshot.nodes,
    archive.snapshot.dailyIndex,
    archive.snapshot.tagColors,
    archive.snapshot.savedQueries,
    archive.snapshot.migrateState,
  ]) {
    if (rows.some((row) => row.userId !== expectedUserId)) {
      return { ok: false, reason: "Lunora projected row ownership mismatch" };
    }
  }

  for (const [table, rows] of Object.entries(archive.raw)) {
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.userId !== expectedUserId) {
        return { ok: false, reason: `raw ${table} row ownership mismatch` };
      }
      const documentId = Schema.decodeUnknownOption(Schema.String)(row._id);
      if (documentId._tag === "None" || documentId.value.length === 0) {
        return { ok: false, reason: `raw ${table} row has no document id` };
      }
      if (ids.has(documentId.value)) {
        return {
          ok: false,
          reason: `duplicate raw ${table} document id ${documentId.value}`,
        };
      }
      ids.add(documentId.value);
    }
  }

  const { raw, snapshot } = archive;
  if (
    raw.nodes.length !== snapshot.nodes.length ||
    raw.dailyIndex.length !== snapshot.dailyIndex.length ||
    raw.tagColors.length !== snapshot.tagColors.length ||
    raw.savedQueries.length !== snapshot.savedQueries.length ||
    raw.migrateState.length !== snapshot.migrateState.length
  ) {
    return { ok: false, reason: "raw and projected populations differ" };
  }
  // Validate each raw row as the exact source shape for its projection. This
  // deliberately does not validate parent/sibling/mirror graph references.
  const projectedSchemas = {
    nodes: Schema.Struct({
      _id: Schema.String,
      _creationTime: Schema.Number,
      ...NodeSourceFields,
      ...OwnedRow,
    }),
    dailyIndex: Schema.Struct({
      _id: Schema.String,
      _creationTime: Schema.Number,
      key: Schema.String,
      nodeId: Schema.String,
      touchedAt: Schema.Number,
      ...OwnedRow,
    }),
    tagColors: Schema.Struct({
      _id: Schema.String,
      _creationTime: Schema.Number,
      tag: Schema.String,
      color: Schema.String,
      ...OwnedRow,
    }),
    savedQueries: Schema.Struct({
      _id: Schema.String,
      _creationTime: Schema.Number,
      name: Schema.String,
      query: Schema.String,
      createdAt: Schema.Number,
      ...OwnedRow,
    }),
    migrateState: Schema.Struct({
      _id: Schema.String,
      _creationTime: Schema.Number,
      nodesAt: Schema.NullOr(Schema.Number),
      kvAt: Schema.NullOr(Schema.Number),
      ...OwnedRow,
    }),
  } as const;
  for (const table of [
    "nodes",
    "dailyIndex",
    "tagColors",
    "savedQueries",
    "migrateState",
  ] as const) {
    if (
      raw[table].some(
        (row) =>
          Schema.decodeUnknownOption(projectedSchemas[table])(row)._tag ===
          "None",
      )
    ) {
      return { ok: false, reason: `raw ${table} row cannot be projected` };
    }
  }

  const projectionsCorrespond =
    snapshot.nodes.every((row, index) => {
      const source = raw.nodes[index];
      if (!source) return false;
      return (
        row.id === source._id &&
        row.parentId === source.parentId &&
        row.prevSiblingId === source.prevSiblingId &&
        row.text === source.text &&
        row.isTask === source.isTask &&
        row.completed === source.completed &&
        row.collapsed === source.collapsed &&
        row.bookmarkedAt === source.bookmarkedAt &&
        row.mirrorOf === source.mirrorOf &&
        row.createdAt === source.createdAt &&
        row.updatedAt === source.updatedAt &&
        row.origin === source.origin &&
        row.kind === source.kind &&
        row.userId === source.userId
      );
    }) &&
    snapshot.dailyIndex.every((row, index) => {
      const source = raw.dailyIndex[index];
      return (
        source !== undefined &&
        row.key === source.key &&
        row.nodeId === source.nodeId &&
        row.touchedAt === source.touchedAt &&
        row.userId === source.userId
      );
    }) &&
    snapshot.tagColors.every((row, index) => {
      const source = raw.tagColors[index];
      return (
        source !== undefined &&
        row.tag === source.tag &&
        row.color === source.color &&
        row.userId === source.userId
      );
    }) &&
    snapshot.savedQueries.every((row, index) => {
      const source = raw.savedQueries[index];
      return (
        source !== undefined &&
        row.id === source._id &&
        row.name === source.name &&
        row.query === source.query &&
        row.createdAt === source.createdAt &&
        row.userId === source.userId
      );
    }) &&
    snapshot.migrateState.every((row, index) => {
      const source = raw.migrateState[index];
      return (
        source !== undefined &&
        row.nodesAt === source.nodesAt &&
        row.kvAt === source.kvAt &&
        row.userId === source.userId
      );
    });
  if (!projectionsCorrespond) {
    return { ok: false, reason: "raw and projected values differ" };
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

const DIAGNOSTIC_SAMPLE_LIMIT = 50;

function diagnosticSample<A>(rows: readonly A[]) {
  return {
    count: rows.length,
    sample: rows.slice(0, DIAGNOSTIC_SAMPLE_LIMIT),
    truncated: rows.length > DIAGNOSTIC_SAMPLE_LIMIT,
  };
}

function compareSideCollection<A>(
  classic: readonly OutlineSnapshot["kv"][number][],
  experimental: readonly A[],
  schema: Schema.ConstraintDecoder<A>,
  keyOf: (row: A) => string,
  valuesOf: (row: A) => readonly unknown[],
) {
  const left = new Map<string, string>();
  const right = new Map(
    experimental.map((row) => [keyOf(row), JSON.stringify(valuesOf(row))]),
  );
  let invalidClassicRows = 0;
  for (const row of classic) {
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      invalidClassicRows++;
      continue;
    }
    const decoded = Schema.decodeUnknownOption(schema)(value);
    if (decoded._tag === "None" || keyOf(decoded.value) !== row.key) {
      invalidClassicRows++;
      continue;
    }
    left.set(row.key, JSON.stringify(valuesOf(decoded.value)));
  }
  const duplicateClassicKeys =
    new Set(classic.map((row) => row.key)).size !== classic.length;
  const duplicateExperimentalKeys = right.size !== experimental.length;
  const comparable =
    invalidClassicRows === 0 &&
    !duplicateClassicKeys &&
    !duplicateExperimentalKeys;
  const shared = [...left.keys()].filter((key) => right.has(key));
  return {
    classic: classic.length,
    experimental: experimental.length,
    comparable,
    invalidClassicRows,
    duplicateClassicKeys,
    duplicateExperimentalKeys,
    // Do not return natural keys, hashes, or values: tags and queries are content.
    classicOnly: comparable ? left.size - shared.length : null,
    experimentalOnly: comparable ? right.size - shared.length : null,
    shared: comparable ? shared.length : null,
    changed: comparable
      ? shared.filter((key) => left.get(key) !== right.get(key)).length
      : null,
  };
}

/** Metadata only. Neither timestamps nor this unfrozen comparison choose a source. */
export function compareRetirementSnapshots(
  classic: OutlineSnapshot,
  experimental: LunoraRetirementSnapshot,
) {
  const left = new Map(classic.nodes.map((row) => [row.id, row]));
  const right = new Map(experimental.nodes.map((row) => [row.id, row]));
  const comparable =
    left.size === classic.nodes.length &&
    right.size === experimental.nodes.length;
  // SAFETY: NodeSchema's field names are the keys of the decoded wire Node.
  const fields = Object.keys(NodeSchema.fields) as (keyof Node)[];
  const changed: Array<{ nodeId: string; fields: (keyof Node)[] }> = [];
  let shared = 0;
  for (const [id, node] of left) {
    const other = right.get(id);
    if (!other) continue;
    shared++;
    const differences = fields.filter((field) => node[field] !== other[field]);
    if (differences.length) changed.push({ nodeId: id, fields: differences });
  }
  const missingReferences = (
    nodes: readonly Node[],
    other: ReadonlyMap<string, Node>,
  ) => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const missing: Array<{
      nodeId: string;
      field: "parentId" | "prevSiblingId" | "mirrorOf";
      referencedId: string;
      presentInOtherBackend: boolean;
      nodePresentInOtherBackend: boolean;
      otherBackendReference: string | null;
    }> = [];
    for (const node of nodes) {
      for (const field of ["parentId", "prevSiblingId", "mirrorOf"] as const) {
        const referencedId = node[field];
        if (referencedId !== null && !byId.has(referencedId)) {
          missing.push({
            nodeId: node.id,
            field,
            referencedId,
            presentInOtherBackend: other.has(referencedId),
            nodePresentInOtherBackend: other.has(node.id),
            otherBackendReference: other.get(node.id)?.[field] ?? null,
          });
        }
      }
    }
    return diagnosticSample(missing);
  };
  const preference = classic.kv.filter(
    (row) => row.collection === "account-prefs" && row.key === "lunora-beta",
  );
  let experimentalPreference: "enabled" | "disabled" | "missing" | "invalid" =
    "missing";
  if (preference.length) {
    experimentalPreference = "invalid";
    const row = preference[0];
    if (preference.length === 1 && row) {
      try {
        const decoded = Schema.decodeUnknownOption(LunoraPreferenceValueSchema)(
          JSON.parse(row.value),
        );
        if (decoded._tag === "Some")
          experimentalPreference = decoded.value.enabled
            ? "enabled"
            : "disabled";
      } catch {
        /* Malformed preferences are reported without echoing their value. */
      }
    }
  }
  return {
    consistency: "unfrozen-snapshots" as const,
    sampleLimit: DIAGNOSTIC_SAMPLE_LIMIT,
    experimentalPreference,
    classicExportedAt: classic.exportedAt,
    experimentalExportedAt: experimental.exportedAt,
    graphs: {
      classic: {
        validation: validateNodeGraph(classic.nodes),
        missingReferences: missingReferences(classic.nodes, right),
      },
      experimental: {
        validation: validateNodeGraph(experimental.nodes),
        missingReferences: missingReferences(experimental.nodes, left),
      },
    },
    nodes: {
      classic: classic.nodes.length,
      experimental: experimental.nodes.length,
      comparable,
      shared: comparable ? shared : null,
      identical: comparable ? shared - changed.length : null,
      classicOnly: comparable
        ? diagnosticSample(
            [...left.keys()].filter((id) => !right.has(id)).sort(),
          )
        : null,
      experimentalOnly: comparable
        ? diagnosticSample(
            [...right.keys()].filter((id) => !left.has(id)).sort(),
          )
        : null,
      changed: comparable
        ? diagnosticSample(
            changed.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
          )
        : null,
    },
    sideCollections: {
      dailyIndex: compareSideCollection(
        classic.kv.filter((row) => row.collection === "daily-index"),
        experimental.dailyIndex,
        ClassicDailyValueSchema,
        (row) => row.key,
        (row) => [row.key, row.nodeId],
      ),
      tagColors: compareSideCollection(
        classic.kv.filter((row) => row.collection === "tag-colors"),
        experimental.tagColors,
        ClassicTagColorValueSchema,
        (row) => row.tag,
        (row) => [row.tag, row.color],
      ),
      savedQueries: compareSideCollection(
        classic.kv.filter((row) => row.collection === "saved-queries"),
        experimental.savedQueries,
        ClassicSavedQueryValueSchema,
        (row) => row.id,
        (row) => [row.id, row.name, row.query, row.createdAt],
      ),
    },
  };
}
