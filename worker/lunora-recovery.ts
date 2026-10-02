import { Schema } from "effect";

import type { Node } from "../src/data/wire-schema";

import {
  NODE_LINK_PATTERN,
  linkTargetId,
  parseNodeLinks,
} from "../src/data/node-links";
import { NodeSchema } from "../src/data/wire-schema";
import { type OutlineSnapshot, SNAPSHOT_VERSION } from "./backup";
import {
  type LunoraRetirementSnapshot,
  RETIREMENT_SNAPSHOT_VERSION,
  validateClassicSnapshot,
  validateNodeGraph,
} from "./lunora-retirement";

export interface PreserveClassicReceipt {
  readonly policy: "preserve-classic-v1";
  readonly migrationId: string;
  readonly classicSnapshotHash: string;
  readonly lunoraSnapshotHash: string;
}

export interface ClassicRecoveryReceipt {
  readonly migrationId: string;
  readonly manifestHash: string;
  readonly applied: boolean;
  readonly seq: number;
  readonly rootId: string | null;
  readonly nodes: number;
}

/** Private content-bearing import manifest, never returned by the admin API. */
export const ClassicRecoveryManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  policy: Schema.Literal("classic-recovery-copies-v1"),
  userId: Schema.String,
  migrationId: Schema.String,
  classicSnapshotHash: Schema.String,
  lunoraSnapshotHash: Schema.String,
  createdAt: Schema.Number,
  rootId: Schema.NullOr(Schema.String),
  nodes: Schema.Array(NodeSchema),
  copies: Schema.Array(
    Schema.Struct({
      sourceId: Schema.String,
      copyId: Schema.String,
      section: Schema.Number,
      contextOnly: Schema.Boolean,
      mirrorPlaceholder: Schema.Boolean,
    }),
  ),
  adaptations: Schema.Array(
    Schema.Struct({
      section: Schema.Number,
      nodeId: Schema.NullOr(Schema.String),
      kind: Schema.Literals([
        "missing-parent",
        "parent-cycle",
        "sibling-order",
      ]),
    }),
  ),
  links: Schema.Struct({
    remapped: Schema.Number,
    classic: Schema.Number,
    unresolved: Schema.Number,
  }),
  summary: Schema.Struct({
    experimentalOnly: Schema.Number,
    substantiveAlternatives: Schema.Number,
    timestampOnly: Schema.Number,
    archiveOnlyDifferences: Schema.Number,
    fieldDifferences: Schema.Record(Schema.String, Schema.Number),
  }),
});

// Exhaustive: adding a wire field requires deciding how recovery treats it.
const FIELD_ROLE = {
  id: "identity",
  parentId: "structure",
  prevSiblingId: "structure",
  text: "content",
  isTask: "content",
  completed: "content",
  kind: "content",
  mirrorOf: "content",
  collapsed: "metadata",
  bookmarkedAt: "metadata",
  createdAt: "metadata",
  updatedAt: "metadata",
  origin: "metadata",
} satisfies Record<
  keyof Node,
  "identity" | "structure" | "content" | "metadata"
>;

/**
 * Pure detached-copy plan, NOT a retirement target or executable import.
 * Inputs must be schema-decoded at the I/O boundary.
 * The caller must retain complete immutable archives, persist the allocated ids,
 * and atomically attach the root against CURRENT Classic with an import receipt.
 * Never send this content-bearing result through the metadata-only diagnostic.
 */
export function planClassicRecovery(
  classic: OutlineSnapshot,
  experimental: LunoraRetirementSnapshot,
  args: { userId: string; timestamp: number; newId: () => string },
) {
  if (
    classic.version !== SNAPSHOT_VERSION ||
    experimental.version !== RETIREMENT_SNAPSHOT_VERSION ||
    experimental.userId !== args.userId ||
    [
      experimental.nodes,
      experimental.dailyIndex,
      experimental.tagColors,
      experimental.savedQueries,
      experimental.migrateState,
    ].some((rows) => rows.some((row) => row.userId !== args.userId))
  ) {
    throw new Error("recovery snapshot version or ownership rejected");
  }
  if (!validateClassicSnapshot(classic).ok)
    throw new Error("recovery requires valid Classic");
  const preference = classic.kv.find(
    (row) => row.collection === "account-prefs" && row.key === "lunora-beta",
  );
  const disabled = Schema.decodeUnknownOption(
    Schema.Struct({ enabled: Schema.Literal(false) }),
  );
  if (!preference || disabled(JSON.parse(preference.value))._tag === "None") {
    throw new Error(
      "recovery requires explicitly disabled experimental preference",
    );
  }
  const classicById = new Map(classic.nodes.map((node) => [node.id, node]));
  const source = new Map(experimental.nodes.map((node) => [node.id, node]));
  if (source.size !== experimental.nodes.length)
    throw new Error("recovery has duplicate experimental node ids");

  const selected: [string[], string[]] = [[], []];
  // SAFETY: NodeSchema is the source of truth for every key of the wire Node.
  const fields = Object.keys(NodeSchema.fields) as (keyof Node)[];
  // SAFETY: Every wire Node key above gets exactly one numeric counter.
  const fieldDifferences = Object.fromEntries(
    fields.map((field) => [field, 0]),
  ) as Record<keyof Node, number>;
  let timestampOnly = 0;
  let archiveOnlyDifferences = 0;
  for (const node of experimental.nodes) {
    const existing = classicById.get(node.id);
    if (!existing) {
      selected[0].push(node.id);
      continue;
    }
    const differences = fields.filter(
      (field) => node[field] !== existing[field],
    );
    for (const field of differences) fieldDifferences[field]++;
    if (differences.some((field) => FIELD_ROLE[field] === "content"))
      selected[1].push(node.id);
    else if (differences.length === 1 && differences[0] === "updatedAt")
      timestampOnly++;
    else if (differences.length) archiveOnlyDifferences++;
  }
  const summary = {
    experimentalOnly: selected[0].length,
    substantiveAlternatives: selected[1].length,
    timestampOnly,
    archiveOnlyDifferences,
    fieldDifferences,
  };
  const nodes: Node[] = [];
  const copies: Array<{
    sourceId: string;
    copyId: string;
    section: number;
    contextOnly: boolean;
    mirrorPlaceholder: boolean;
  }> = [];
  const adaptations: Array<{
    section: number;
    nodeId: string | null;
    kind: "missing-parent" | "parent-cycle" | "sibling-order";
  }> = [];
  const links = { remapped: 0, classic: 0, unresolved: 0 };
  if (!selected[0].length && !selected[1].length) {
    return {
      policy: "classic-recovery-copies-v1" as const,
      rootId: null,
      nodes,
      copies,
      adaptations,
      links,
      summary,
    };
  }

  // Reserve absent claims and referenced ids too: a fresh copy must not make an
  // old missing reference, or a future rematerialized day, change its identity.
  const reserved = new Set<string>();
  for (const node of [...classic.nodes, ...experimental.nodes]) {
    reserved.add(node.id);
    for (const id of [
      node.parentId,
      node.prevSiblingId,
      node.mirrorOf,
      ...parseNodeLinks(node.text),
    ])
      if (id !== null) reserved.add(id);
  }
  for (const row of experimental.dailyIndex) reserved.add(row.nodeId);
  const dailyClaim = Schema.Struct({ nodeId: Schema.String });
  for (const row of classic.kv) {
    if (row.collection !== "daily-index") continue;
    const claim = Schema.decodeUnknownOption(dailyClaim)(JSON.parse(row.value));
    if (claim._tag === "Some") reserved.add(claim.value.nodeId);
  }
  const mint = () => {
    const id = args.newId();
    if (!id || reserved.has(id))
      throw new Error("recovery id allocation collided");
    reserved.add(id);
    return id;
  };
  const synthetic = (
    text: string,
    parentId: string | null,
    prevSiblingId: string | null,
  ): Node =>
    NodeSchema.make({
      id: mint(),
      parentId,
      prevSiblingId,
      text,
      isTask: false,
      completed: false,
      collapsed: false,
      bookmarkedAt: null,
      mirrorOf: null,
      createdAt: args.timestamp,
      updatedAt: args.timestamp,
      origin: null,
      kind: null,
    });
  const root = synthetic("Recovered experimental content", null, null);
  nodes.push(root);
  const about = synthetic(
    "Editable copies, not automatically newer or lost items. Selected descendants only; placement and order may be adapted. Mirrors remain in the private archive. Links outside these copies may open Classic or be unresolved. The complete original snapshots remain in the private archive.",
    root.id,
    null,
  );
  nodes.push(about);

  // Allocate actual content copies first so forward links work across sections.
  const contentIds = new Map<string, string>();
  for (const ids of selected)
    for (const id of [...ids].sort()) contentIds.set(id, mint());
  let previousSection = about.id;
  for (const [section, selectedIds] of selected.entries()) {
    if (!selectedIds.length) continue;
    const heading = synthetic(
      section === 0
        ? "Present only in experimental"
        : "Alternative text and task state",
      root.id,
      previousSection,
    );
    nodes.push(heading);
    previousSection = heading.id;
    const candidates = new Set(selectedIds);
    const included = new Map<string, Node>();
    for (const id of [...selectedIds].sort()) {
      let current: string | null = id;
      while (current !== null && !included.has(current)) {
        const row = source.get(current);
        if (!row) break;
        included.set(current, row);
        current = row.parentId;
      }
    }
    const ids = new Map<string, string>();
    const parents = new Map<string, string | null>();
    for (const [id, row] of [...included].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      ids.set(id, candidates.has(id) ? (contentIds.get(id) ?? mint()) : mint());
      parents.set(
        id,
        row.parentId !== null && included.has(row.parentId)
          ? row.parentId
          : null,
      );
      if (row.parentId !== null && !included.has(row.parentId))
        adaptations.push({ section, nodeId: id, kind: "missing-parent" });
    }
    // Break each cycle once, in a reproducible place, in the COPY layout only.
    const processed = new Set<string>();
    for (const id of [...included.keys()].sort()) {
      const path: string[] = [];
      const positions = new Map<string, number>();
      let current: string | null = id;
      while (current !== null && !processed.has(current)) {
        const cycleAt = positions.get(current);
        if (cycleAt !== undefined) {
          const anchor = path.slice(cycleAt).sort()[0];
          if (anchor === undefined) throw new Error("empty recovery cycle");
          parents.set(anchor, null);
          adaptations.push({ section, nodeId: anchor, kind: "parent-cycle" });
          break;
        }
        positions.set(current, path.length);
        path.push(current);
        current = parents.get(current) ?? null;
      }
      for (const visited of path) processed.add(visited);
    }
    const groups = new Map<string | null, string[]>();
    for (const id of included.keys()) {
      const parent = parents.get(id) ?? null;
      const siblings = groups.get(parent) ?? [];
      siblings.push(id);
      groups.set(parent, siblings);
    }
    for (const [parent, childIds] of groups) {
      // Establish source order INCLUDING unselected siblings, then prune it.
      const siblings = experimental.nodes.filter(
        (row) => row.parentId === parent,
      );
      const next = new Map<string | null, Node>();
      let valid = siblings.every((row) => {
        if (next.has(row.prevSiblingId)) return false;
        next.set(row.prevSiblingId, row);
        return true;
      });
      const ordered: string[] = [];
      const seen = new Set<string>();
      let row = next.get(null);
      while (row && !seen.has(row.id)) {
        seen.add(row.id);
        ordered.push(row.id);
        row = next.get(row.id);
      }
      valid =
        valid &&
        seen.size === siblings.length &&
        childIds.every((id) => seen.has(id));
      const order = valid
        ? ordered.filter((id) => childIds.includes(id))
        : [...childIds].sort();
      if (!valid)
        adaptations.push({ section, nodeId: parent, kind: "sibling-order" });
      let previous: string | null = null;
      for (const sourceId of order) {
        const original = included.get(sourceId);
        const copyId = ids.get(sourceId);
        if (!original || !copyId) throw new Error("recovery layout incomplete");
        const contextOnly = !candidates.has(sourceId);
        const mirrorPlaceholder = original.mirrorOf !== null;
        let text = mirrorPlaceholder
          ? "Mirror reference: original contents and reference retained in the private archive."
          : contextOnly
            ? `Context only, selected descendants: ${original.text}`
            : original.text;
        text = text.replace(new RegExp(NODE_LINK_PATTERN, "g"), (token) => {
          const target = linkTargetId(token);
          const mapped = contentIds.get(target);
          if (mapped && source.get(target)?.mirrorOf === null) {
            links.remapped++;
            return `[[${mapped}]]`;
          }
          if (classicById.has(target)) links.classic++;
          else links.unresolved++;
          return token;
        });
        const copy: Node = {
          ...original,
          id: copyId,
          parentId:
            parent === null ? heading.id : (ids.get(parent) ?? heading.id),
          prevSiblingId: previous,
          text,
          mirrorOf: null,
          collapsed: false,
          bookmarkedAt: null,
          isTask: contextOnly || mirrorPlaceholder ? false : original.isTask,
          completed:
            contextOnly || mirrorPlaceholder ? false : original.completed,
          kind: contextOnly || mirrorPlaceholder ? null : original.kind,
        };
        // Strip export-only ownership and any future projection extras.
        nodes.push(Schema.decodeUnknownSync(NodeSchema)(copy));
        copies.push({
          sourceId,
          copyId,
          section,
          contextOnly,
          mirrorPlaceholder,
        });
        previous = copyId;
      }
    }
  }
  if (!validateNodeGraph(nodes).ok)
    throw new Error("recovery produced an invalid copy graph");
  return {
    policy: "classic-recovery-copies-v1" as const,
    rootId: root.id,
    nodes,
    copies,
    adaptations,
    links,
    summary,
  };
}
