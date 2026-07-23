/**
 * The MCP tool registry: what an agent can do to an outline. Each tool is an
 * Effect Schema input (the validator IS the published contract — the schema in
 * `tools/list` is derived from the same value that gates `tools/call`, ADR
 * 0014's one-source rule) plus an Effect handler over an `OutlineStore` (the
 * caller's per-user DO stub in production, an in-memory fake in tests).
 *
 * Agent-native posture: whatever a human can do in the editor, within reason —
 * read/search the outline, add/edit/delete nodes, put things on today's daily
 * note, mirror nodes. Every write is planned purely (worker/outline-ops.ts)
 * and committed through the DO's `applyBatch` as ONE atomic frame (ADR 0009),
 * so a connected editor sees an agent's edit live over the same sync socket a
 * second device would. The core protection rule holds here too: the daily
 * container can't be deleted, blanked, made a task, or completed (ADR 0015).
 */

import { Data, Effect, Schema } from "effect";

import type { ChangeOp, Node } from "../src/data/wire-schema";

import {
  PROTECTED_SCAFFOLD_KINDS,
  dayKeyToScaffoldChain,
  scaffoldKeyKind,
  scaffoldLabel,
} from "../src/data/date-links";
import { exportOpml } from "../src/data/opml-export";
import {
  OPML_MCP_MAX_NODES,
  type OpmlImportReport,
  parseOpml,
  planOpmlImport,
} from "../src/data/opml-import";
import { redactSpoilers } from "../src/data/spoiler";
import { childrenOf, createId } from "../src/data/tree";
import {
  DAILY_CONTAINER_TEXT,
  type DailyScaffold,
  type TreeIndex,
  buildTreeIndex,
  flattenSubtree,
  formatDayText,
  isValidDateKey,
  formatOutlineLines,
  guardForestSize,
  type SubtreeInput,
  planAddNode,
  planAddSubtree,
  planAddSubtreeToDaily,
  planAddToDaily,
  planDeleteNode,
  planEnsureDaily,
  planMirrorNode,
  planMirrorToDaily,
  planReparent,
  planUpdateNode,
  redactSpoilerIndex,
  searchNodes,
  trueSourceOf,
} from "./outline-ops";

// Re-exported so worker/index.ts can hand the DO stub over without importing
// the planner module directly.
export type { ChangeOp, Node };

/**
 * The slice of the per-user DO a tool needs. `DurableObjectStub<UserOutlineDO>`
 * satisfies it structurally (stub RPC methods return Promises; the sync returns
 * cover an in-process fake in tests).
 */
export interface OutlineStore {
  getNodes(): Node[] | Promise<Node[]>;
  applyBatch(ops: readonly ChangeOp[]): number | Promise<number>;
  getKv(collection: string): unknown[] | Promise<unknown[]>;
  getOrCreateKv(
    collection: string,
    key: string,
    value: unknown,
  ): unknown | Promise<unknown>;
}

/** A tool execution failure — surfaces as an `isError` tool result (the MCP
 *  shape for "the tool ran and refused"), never a protocol-level error. */
export class ToolError extends Data.TaggedError("ToolError")<{
  reason: string;
}> {
  get message() {
    return this.reason;
  }
}

export interface ToolDef {
  name: string;
  description: string;
  /** Input contract; also the source of the published JSON Schema. */
  input: Schema.Struct<any>;
  /** MCP `readOnlyHint` — true for tools that never write. */
  readOnly: boolean;
  /** `origin` is the caller's provenance stamp — the OAuth client's harness name
   *  (worker/index.ts resolves it from the bearer token), written onto every node
   *  a write tool creates so the editor can tell agent edits from the user's own.
   *  Read-only tools ignore it. */
  handle: (
    input: any,
    store: OutlineStore,
    origin: string | null,
  ) => Effect.Effect<string, ToolError>;
}

// --- Shared plumbing ----------------------------------------------------------

const loadIndex = (store: OutlineStore): Effect.Effect<TreeIndex> =>
  Effect.promise(async () => buildTreeIndex(await store.getNodes()));

const commit = (
  store: OutlineStore,
  ops: ReadonlyArray<ChangeOp>,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (ops.length) await store.applyBatch(ops);
  });

/** Lift a planner's value-shaped failure into the tool error channel,
 *  narrowing the success side (the planners' errors all extend `Error`). */
const unwrap = <A>(result: A): Effect.Effect<Exclude<A, Error>, ToolError> =>
  result instanceof Error
    ? Effect.fail(new ToolError({ reason: result.message }))
    : Effect.succeed(result as Exclude<A, Error>);

const clock = Effect.sync(() => Date.now());

// --- Daily-index claims -------------------------------------------------------

const KV_DAILY = "daily-index";
const CONTAINER_KEY = "container";

const DailyRowSchema = Schema.Struct({
  key: Schema.String,
  nodeId: Schema.String,
});

/** Atomically claim `key -> candidate` in the daily index and return the
 *  authoritative winner — the DO-side twin of the client's `claimMapping`. */
const claimDailyId = (
  store: OutlineStore,
  key: string,
  candidate: string,
): Effect.Effect<string, ToolError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.promise(() =>
      Promise.resolve(
        store.getOrCreateKv(KV_DAILY, key, { key, nodeId: candidate }),
      ),
    );
    const row = yield* Schema.decodeUnknownEffect(DailyRowSchema)(raw).pipe(
      Effect.mapError(
        () =>
          new ToolError({
            reason: `daily index row for "${key}" is malformed`,
          }),
      ),
    );
    return row.nodeId;
  });

/** The daily-index reverse map (nodeId -> scaffold key) — powers both the
 *  chronological-ascending sibling insertion in `planEnsureDaily` and the
 *  server-side protection guards (which resolve a node id to its scaffold kind).
 *  A read, no side effects. */
const loadDailyReverseMap = (
  store: OutlineStore,
): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.gen(function* () {
    const rows = yield* Effect.promise(() =>
      Promise.resolve(store.getKv(KV_DAILY)),
    );
    const map = new Map<string, string>();
    for (const raw of rows) {
      const row = Schema.decodeUnknownOption(DailyRowSchema)(raw);
      if (row._tag === "Some") map.set(row.value.nodeId, row.value.key);
    }
    return map;
  });

/** The claimed ids of the whole `Daily > YYYY > Month > Week > Day` chain plus
 *  the reverse map — the DO-side twin of the client's ensure cascade (issue
 *  #271). Each level is claimed atomically PER LEVEL through `getOrCreateKv`, so
 *  two concurrent agents converge on ONE node per level; `planEnsureDaily` then
 *  materializes whichever rows are missing and sorts them into place. */
const claimDailyScaffold = (
  store: OutlineStore,
  dateKey: string,
): Effect.Effect<DailyScaffold & { index: TreeIndex }, ToolError> =>
  Effect.gen(function* () {
    const chain = dayKeyToScaffoldChain(dateKey);
    if (!chain) {
      return yield* Effect.fail(
        new ToolError({
          reason: `invalid date "${dateKey}" — can't place it on the calendar`,
        }),
      );
    }
    // Container + day claims and the reverse-map fetch are independent, so run
    // them CONCURRENTLY (finding 6/8b: was 6 sequential RPCs). Each claim is a
    // per-key atomic `getOrCreateKv` on a FRESH candidate id, and nothing reads
    // another claim's result, so the batch is race-safe.
    const [containerId, dayId, keyByNodeId] = yield* Effect.all(
      [
        claimDailyId(store, CONTAINER_KEY, createId()),
        claimDailyId(store, dateKey, createId()),
        loadDailyReverseMap(store),
      ],
      { concurrency: "unbounded" },
    );

    // The Y/M/W scaffold is claimed ONLY when the day node is absent (finding 6,
    // mirroring `planEnsureDaily`'s early-return): an existing (pre-migration
    // flat) day is reused verbatim and never gets a parallel scaffold, so no
    // dangling kv mappings. One index read decides -- and it's RETURNED so the
    // caller reuses it (finding 6): nothing between here and the caller's plan
    // mutates nodes (only kv claims), so a second `loadIndex` would rebuild the
    // identical tree.
    const index = yield* loadIndex(store);
    if (index.byId.has(dayId))
      return { containerId, dayId, keyByNodeId, index };

    const [yearId, monthId, weekId] = yield* Effect.all(
      [
        claimDailyId(store, chain.yearKey, createId()),
        claimDailyId(store, chain.monthKey, createId()),
        claimDailyId(store, chain.weekKey, createId()),
      ],
      { concurrency: "unbounded" },
    );
    return { containerId, yearId, monthId, weekId, dayId, keyByNodeId, index };
  });

/** Resolve the tool's optional `date` input to a valid `YYYY-MM-DD` key. The
 *  default is the server's UTC today — tools advertise that callers should pass
 *  the user's local date, since the Worker can't know their timezone. */
const resolveDateKey = (
  date: string | null | undefined,
): Effect.Effect<string, ToolError> =>
  date == null
    ? Effect.sync(() => new Date().toISOString().slice(0, 10))
    : isValidDateKey(date)
      ? Effect.succeed(date)
      : Effect.fail(
          new ToolError({
            reason: `invalid date "${date}" — expected a real YYYY-MM-DD`,
          }),
        );

// --- Protection (ADR 0015, server-enforced) -----------------------------------
// The daily container AND every intermediate calendar scaffold node (year,
// month, week) are protected: no delete / blank / to-do / complete (issue #271
// decision 6). Deleting any of them cascades — an unprotected week delete would
// take its days with it. Days themselves are content, so they stay editable and
// deletable. A node's protection is resolved from the daily-index reverse map:
// its key's `scaffoldKeyKind` tells container/year/month/week apart from day.

/** The human label for a PROTECTED scaffold node (container/year/month/week), or
 *  null when the key is a day or unknown (not protected). */
const protectedScaffoldLabel = (key: string): string | null => {
  const kind = scaffoldKeyKind(key);
  // Which kinds are protected is the shared source of truth (finding 10b), so
  // the client and Worker can't drift on it. The label derives from the shared
  // `scaffoldLabel` (10c); the phrasing stays Worker-local.
  if (!kind || !PROTECTED_SCAFFOLD_KINDS.has(kind)) return null;
  switch (kind) {
    case "container":
      return `the "${DAILY_CONTAINER_TEXT}" container`;
    case "year":
      return `the "${scaffoldLabel(key)}" calendar year`;
    case "month":
      return `the "${scaffoldLabel(key)}" calendar month`;
    case "week":
      return `the "${scaffoldLabel(key)}" calendar week`;
    default:
      return null; // day (content) or unknown
  }
};

const guardScaffoldDelete = (
  keyByNodeId: ReadonlyMap<string, string>,
  deletedIds: ReadonlyArray<string>,
): Effect.Effect<void, ToolError> => {
  for (const id of deletedIds) {
    const key = keyByNodeId.get(id);
    const label = key ? protectedScaffoldLabel(key) : null;
    if (label)
      return Effect.fail(
        new ToolError({
          reason: `${label} is protected and can't be deleted (it holds your daily notes)`,
        }),
      );
  }
  return Effect.void;
};

const guardScaffoldUpdate = (
  index: TreeIndex,
  keyByNodeId: ReadonlyMap<string, string>,
  nodeId: string,
  changes: { text?: string; isTask?: boolean; completed?: boolean },
): Effect.Effect<void, ToolError> => {
  if (!index.byId.has(nodeId)) return Effect.void;
  // A content edit follows the mirror's true source; check both the raw id and
  // its source so a mirror of a scaffold node is guarded too.
  const key =
    keyByNodeId.get(trueSourceOf(index, nodeId)) ?? keyByNodeId.get(nodeId);
  const label = key ? protectedScaffoldLabel(key) : null;
  if (!label) return Effect.void;
  const violation =
    changes.text !== undefined && !changes.text.trim()
      ? "blanked (it's how your daily notes are found)"
      : changes.isTask
        ? "made a to-do"
        : changes.completed
          ? "completed"
          : null;
  return violation
    ? Effect.fail(
        new ToolError({
          reason: `${label} is protected and can't be ${violation}`,
        }),
      )
    : Effect.void;
};

// --- Input schemas ------------------------------------------------------------
// `Schema.optional(Schema.NullOr(...))` throughout: the published JSON Schema
// advertises `T | null`, and the decoder accepts BOTH an omitted key and an
// explicit null — agents routinely send either.

const optional = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

/** Node kind (ADR 0045). The only value is `"paragraph"`; omit it (or pass null)
 *  for a plain bullet or, with `isTask`, a to-do. `kind` overrides `isTask`. */
const kindField = optional(
  Schema.Literal("paragraph").annotate({
    description:
      "Create as a paragraph (prose, drawn with a paragraph glyph instead of a bullet) rather than a list item. Mutually exclusive with isTask, which it overrides.",
  }),
);

const GetOutlineInput = Schema.Struct({
  nodeId: optional(
    Schema.String.annotate({
      description:
        "Root node to read from. Omit to read the whole outline from the top level.",
    }),
  ),
  maxDepth: optional(
    Schema.Int.annotate({
      description: "How many levels deep to read (default: unlimited).",
    }),
  ),
});

const SearchNodesInput = Schema.Struct({
  query: Schema.String.annotate({
    description: "Case-insensitive text to find in node text.",
  }),
});

const AddNodeInput = Schema.Struct({
  text: Schema.String.annotate({ description: "The bullet text." }),
  parentId: optional(
    Schema.String.annotate({
      description: "Parent node id. Omit to add at the top level.",
    }),
  ),
  position: optional(
    Schema.Literals(["first", "last"]).annotate({
      description: "Insert as the first or last child (default: last).",
    }),
  ),
  isTask: optional(
    Schema.Boolean.annotate({
      description: "Create as a to-do with a checkbox (default: false).",
    }),
  ),
  kind: kindField,
});

/** One node in an `add_subtree` forest — recursive via `Schema.suspend`, which
 *  publishes as a named `$ref`/`$defs` in `tools/list` (ADR 0028). Fresh content
 *  only: text + optional to-do flag + optional nested children. The decoded type
 *  IS the planner's own `SubtreeInput` — one shape, one source. */
const SubtreeNodeInput: Schema.Codec<SubtreeInput> = Schema.Struct({
  text: Schema.String.annotate({ description: "The bullet text." }),
  isTask: optional(
    Schema.Boolean.annotate({
      description: "Create as a to-do with a checkbox (default: false).",
    }),
  ),
  kind: kindField,
  children: optional(
    Schema.Array(
      Schema.suspend((): Schema.Codec<SubtreeInput> => SubtreeNodeInput),
    ).annotate({
      description: "Nested child bullets, each with this same shape.",
    }),
  ),
}).annotate({ identifier: "SubtreeNode" });

const AddSubtreeInput = Schema.Struct({
  nodes: Schema.Array(SubtreeNodeInput).annotate({
    description:
      "The bullets to create, as a nested forest. Each node may carry its own `children`, so a whole outline lands in one call.",
  }),
  parentId: optional(
    Schema.String.annotate({
      description:
        "Parent node id to add under. Omit for the top level. Mutually exclusive with `date`.",
    }),
  ),
  date: optional(
    Schema.String.annotate({
      description:
        "Add onto the daily note for this YYYY-MM-DD instead of a parent (pass the user's local date). Mutually exclusive with `parentId`.",
    }),
  ),
  position: optional(
    Schema.Literals(["first", "last"]).annotate({
      description:
        "Insert the forest as the first or last children of the parent (default: last). Ignored for the `date` path, which always appends.",
    }),
  ),
});

const UpdateNodeInput = Schema.Struct({
  nodeId: Schema.String.annotate({ description: "The node to update." }),
  text: optional(Schema.String.annotate({ description: "New bullet text." })),
  isTask: optional(
    Schema.Boolean.annotate({
      description:
        "Turn the checkbox on (true) or off (false). Either value also turns a paragraph back into a list item — a node is exactly one of bullet, to-do, or paragraph.",
    }),
  ),
  completed: optional(
    Schema.Boolean.annotate({
      description: "Mark done (true) or not done (false).",
    }),
  ),
  collapsed: optional(
    Schema.Boolean.annotate({
      description: "Collapse (true) or expand (false) the bullet.",
    }),
  ),
  // Two explicit words rather than `"paragraph" | null`: an omitted key and an
  // explicit null both decode to "no change" everywhere else in this schema set,
  // so null cannot also mean "make it a bullet". `"bullet"` says it out loud.
  kind: optional(
    Schema.Literals(["paragraph", "bullet"]).annotate({
      description:
        'Turn the node into a paragraph ("paragraph") or back into a plain list item ("bullet"). Overrides isTask in the same call.',
    }),
  ),
});

const DeleteNodeInput = Schema.Struct({
  nodeId: Schema.String.annotate({
    description: "The node to delete. Its whole subtree is deleted with it.",
  }),
});

const MoveNodesInput = Schema.Struct({
  nodeIds: Schema.Array(Schema.String).annotate({
    description:
      "The nodes to move. Each moves with its whole subtree; the order you pass is kept.",
  }),
  newParentId: optional(
    Schema.String.annotate({
      description: "Where to move them. Omit or null for the top level.",
    }),
  ),
  position: optional(
    Schema.Literals(["first", "last"]).annotate({
      description:
        "Land as the first or last children of the parent (default: last).",
    }),
  ),
});

const dateField = optional(
  Schema.String.annotate({
    description:
      "The day's date as YYYY-MM-DD. Pass the user's local date; defaults to today in UTC.",
  }),
);

const AddToTodayInput = Schema.Struct({
  text: Schema.String.annotate({
    description: "The bullet text to add to the daily note.",
  }),
  isTask: optional(
    Schema.Boolean.annotate({
      description: "Create as a to-do with a checkbox (default: false).",
    }),
  ),
  kind: kindField,
  date: dateField,
});

const MirrorNodeInput = Schema.Struct({
  nodeId: Schema.String.annotate({
    description: "The node to mirror (its subtree comes with it).",
  }),
  parentId: optional(
    Schema.String.annotate({
      description: "Where to put the mirror. Omit to mirror to the top level.",
    }),
  ),
});

const MirrorToTodayInput = Schema.Struct({
  nodeId: Schema.String.annotate({
    description: "The node to mirror onto the daily note.",
  }),
  date: dateField,
});

// The OPML pair (ADR 0037). The document travels as a plain string — a
// non-recursive input, so no `identifier` annotation is needed (unlike
// add_subtree's forest). Deliberately NO url-fetch argument: fetching a
// caller-supplied URL from the Worker is an authenticated SSRF surface
// re-treading unfurl.ts for territory the string argument already covers.

const ImportOpmlInput = Schema.Struct({
  opml: Schema.String.annotate({
    description:
      "The OPML document to import, as an XML string (e.g. a Workflowy export).",
  }),
  parentId: optional(
    Schema.String.annotate({
      description:
        "Parent node id to import under. Omit for the top level. Mutually exclusive with `date`.",
    }),
  ),
  date: optional(
    Schema.String.annotate({
      description:
        "Import onto the daily note for this YYYY-MM-DD instead of a parent (pass the user's local date). Mutually exclusive with `parentId`.",
    }),
  ),
  dryRun: optional(
    Schema.Boolean.annotate({
      description:
        "Parse and plan without writing anything; returns the same receipt (default: false).",
    }),
  ),
});

const ExportOpmlInput = Schema.Struct({
  nodeId: optional(
    Schema.String.annotate({
      description:
        "Root node to export (the node and its whole subtree). Omit to export the whole outline.",
    }),
  ),
});

// --- The tools ----------------------------------------------------------------

const MAX_OUTLINE_NODES = 500;
const MAX_SEARCH_HITS = 25;
/** One `add_subtree` batch = one DO `transactionSync` = one sync frame; cap the
 *  forest at the same ceiling an agent hits reading back (ADR 0028). */
const MAX_BATCH_NODES = 500;

/** Render a freshly-planned forest as the agent-facing bullet list with ids —
 *  built from the plan's own insert ops, so no extra read of the store. */
const renderCreatedForest = (
  ops: ReadonlyArray<ChangeOp>,
  rootIds: ReadonlyArray<string>,
): string => {
  const created = buildTreeIndex(
    ops.flatMap((o) => (o.op === "insert" ? [o.value] : [])),
  );
  const lines = rootIds.flatMap((id) => {
    const r = flattenSubtree(created, id, {
      maxDepth: Number.POSITIVE_INFINITY,
      maxNodes: MAX_BATCH_NODES,
    });
    return r instanceof Error ? [] : r.lines;
  });
  return formatOutlineLines(lines);
};

// --- OPML receipt (ADR 0037) ----------------------------------------------------
// import_opml never echoes the forest back (the caller already holds the
// document); it answers with a COMPACT receipt — root ids + texts, counts, and
// the degradation tally with zero-count lines omitted. This is the only place
// MCP disclosure can live, so the "degraded, never silent" bar lands here.

/** Cap the receipt's root listing — a wide document can carry thousands of
 *  top-level outlines, and the receipt must stay compact. */
const MAX_RECEIPT_ROOTS = 20;

const tallyLines = (record: Record<string, number>): string[] =>
  Object.entries(record).map(([msg, n]) => `- ${msg}: ${n}`);

const renderImportReceipt = (args: {
  report: OpmlImportReport;
  rootIds: ReadonlyArray<string>;
  rootTexts: ReadonlyArray<string>;
  landing: string;
  dryRun: boolean;
}): string => {
  const { report } = args;
  const lines: string[] = [
    args.dryRun
      ? `Dry run — would import ${report.nodesPost} node(s) ${args.landing}. Nothing was written.`
      : `Imported ${report.nodesPost} node(s) ${args.landing}.`,
    `Root bullet(s) (${args.rootIds.length}):`,
  ];
  const shown = args.rootIds.slice(0, MAX_RECEIPT_ROOTS);
  shown.forEach((id, i) => {
    lines.push(`- "${args.rootTexts[i] || "(empty)"}" (id: ${id})`);
  });
  if (args.rootIds.length > shown.length) {
    lines.push(`- … and ${args.rootIds.length - shown.length} more`);
  }
  const counts: string[] = [];
  if (report.nodesPost !== report.nodesPre) {
    counts.push(
      `${report.nodesPre} OPML outline(s) became ${report.nodesPost} bullet(s) after note/newline splitting`,
    );
  }
  if (report.notes)
    counts.push(
      `${report.notes} _note attribute(s) -> ${report.noteLines} child bullet(s)`,
    );
  if (report.textNewlineSplits)
    counts.push(
      `${report.textNewlineSplits} bullet(s) split on embedded newlines`,
    );
  if (report.emptyText) counts.push(`${report.emptyText} empty-text bullet(s)`);
  if (report.mirrorsLinked)
    counts.push(`${report.mirrorsLinked} mirror(s) re-linked`);
  if (report.mirrorsDetached)
    counts.push(
      `${report.mirrorsDetached} mirror(s) imported as detached copies`,
    );
  if (counts.length) {
    lines.push("Counts:");
    for (const c of counts) lines.push(`- ${c}`);
  }
  if (report.degradedTotal === 0) {
    lines.push("No fidelity degradations.");
  } else {
    lines.push(`Fidelity degradations (${report.degradedTotal}):`);
    lines.push(...tallyLines(report.degraded));
  }
  if (Object.keys(report.anomalies).length) {
    lines.push("Tolerated HTML anomalies:");
    lines.push(...tallyLines(report.anomalies));
  }
  if (Object.keys(report.unknownAttributes).length) {
    lines.push("Unknown OPML attributes (ignored):");
    lines.push(...tallyLines(report.unknownAttributes));
  }
  return lines.join("\n");
};

export const tools: ReadonlyArray<ToolDef> = [
  {
    name: "get_outline",
    description:
      "Read the outline (or one node and its subtree) as an indented bullet list. Every line carries its node id — use those ids with the other tools.",
    input: GetOutlineInput,
    readOnly: true,
    handle: (input: typeof GetOutlineInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store);
        const result = yield* unwrap(
          flattenSubtree(index, input.nodeId ?? null, {
            maxDepth: input.maxDepth ?? Number.POSITIVE_INFINITY,
            maxNodes: MAX_OUTLINE_NODES,
          }),
        );
        if (!result.lines.length) return "The outline is empty.";
        const body = formatOutlineLines(result.lines);
        return result.truncated
          ? `${body}\n\n(truncated at ${MAX_OUTLINE_NODES} nodes — read a subtree via nodeId for more)`
          : body;
      }),
  },
  {
    name: "search_nodes",
    description:
      "Find nodes by text (case-insensitive substring). Returns each match with its id and breadcrumb path.",
    input: SearchNodesInput,
    readOnly: true,
    handle: (input: typeof SearchNodesInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store);
        const hits = searchNodes(index, input.query, MAX_SEARCH_HITS);
        if (!hits.length) return `No nodes match "${input.query}".`;
        const body = hits
          .map((h) => {
            const path = h.path.length ? ` — in: ${h.path.join(" > ")}` : "";
            const meta =
              h.kind === "paragraph" ? `id: ${h.id}, paragraph` : `id: ${h.id}`;
            return `- "${h.text}" (${meta})${path}`;
          })
          .join("\n");
        return hits.length >= MAX_SEARCH_HITS
          ? `${body}\n\n(first ${MAX_SEARCH_HITS} matches)`
          : body;
      }),
  },
  {
    name: "add_node",
    description:
      'Add a new bullet to the outline — under a parent node or at the top level. Pass kind: "paragraph" for prose. Returns the new node id.',
    input: AddNodeInput,
    readOnly: false,
    handle: (input: typeof AddNodeInput.Type, store, origin) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store);
        const timestamp = yield* clock;
        const plan = yield* unwrap(
          planAddNode(index, {
            id: createId(),
            text: input.text,
            parentId: input.parentId ?? null,
            position: input.position ?? "last",
            isTask: input.isTask ?? false,
            kind: input.kind ?? null,
            origin,
            timestamp,
          }),
        );
        yield* commit(store, plan.ops);
        const where = plan.parentId
          ? `under "${redactSpoilers(index.byId.get(plan.parentId)?.text ?? plan.parentId)}"`
          : "at the top level";
        return `Added "${input.text}" ${where} (id: ${plan.nodeId}).`;
      }),
  },
  {
    name: "add_subtree",
    description:
      "Add a whole nested outline — a forest of bullets, each with its own children — in ONE atomic call. Use this instead of many add_node calls when building structure. Target a parent (parentId), the top level (omit both), or the user's daily note (date). Returns the created bullets with their ids.",
    input: AddSubtreeInput,
    readOnly: false,
    handle: (input: typeof AddSubtreeInput.Type, store, origin) =>
      Effect.gen(function* () {
        if (input.parentId != null && input.date != null) {
          return yield* Effect.fail(
            new ToolError({ reason: "pass either parentId or date, not both" }),
          );
        }
        const timestamp = yield* clock;

        // Daily path: claim the container + day ids atomically, then ensure-and-
        // append the forest under the day (position is ignored — always last).
        if (input.date != null) {
          const dateKey = yield* resolveDateKey(input.date);
          // Validate the forest BEFORE claiming any daily-index ids, so an empty
          // or over-cap forest can't leave orphan container/day mappings pointing
          // at nodes we never insert (ADR 0028 all-or-nothing).
          const sizeError = guardForestSize(input.nodes, MAX_BATCH_NODES);
          if (sizeError != null) {
            return yield* Effect.fail(
              new ToolError({ reason: sizeError.message }),
            );
          }
          const scaffold = yield* claimDailyScaffold(store, dateKey);
          // Reuse the index claimDailyScaffold already built -- only kv claims ran
          // since, so a reload would rebuild the identical tree (finding 6).
          const index = scaffold.index;
          const plan = yield* unwrap(
            planAddSubtreeToDaily(index, {
              nodes: input.nodes,
              dateKey,
              ...scaffold,
              origin,
              timestamp,
              newId: createId,
              maxNodes: MAX_BATCH_NODES,
            }),
          );
          yield* commit(store, plan.ops);
          return `Added ${plan.rootIds.length} bullet(s) to ${formatDayText(dateKey)} (daily note id: ${scaffold.dayId}):\n${renderCreatedForest(plan.ops, plan.rootIds)}`;
        }

        // Parent (or top-level) path.
        const index = yield* loadIndex(store);
        const plan = yield* unwrap(
          planAddSubtree(index, {
            nodes: input.nodes,
            parentId: input.parentId ?? null,
            position: input.position ?? "last",
            origin,
            timestamp,
            newId: createId,
            maxNodes: MAX_BATCH_NODES,
          }),
        );
        yield* commit(store, plan.ops);
        const where = plan.parentId
          ? `under "${redactSpoilers(index.byId.get(plan.parentId)?.text ?? plan.parentId)}"`
          : "at the top level";
        const kind = plan.parentId ? "bullet(s)" : "top-level bullet(s)";
        return `Added ${plan.rootIds.length} ${kind} ${where}:\n${renderCreatedForest(plan.ops, plan.rootIds)}`;
      }),
  },
  {
    name: "update_node",
    description:
      "Edit a node's text, to-do state, done state, or collapsed state. Editing a mirror edits the shared content everywhere it appears. WARNING: spoiler runs (||...||) are redacted to `[spoiler]` when you read a node, so passing that read-back text as the new `text` DESTROYS the hidden spoiler content. When editing a node that shows `[spoiler]`, ask the user for the intended full text instead of writing back what you were given.",
    input: UpdateNodeInput,
    readOnly: false,
    handle: (input: typeof UpdateNodeInput.Type, store) =>
      Effect.gen(function* () {
        const changes = {
          ...(input.text != null ? { text: input.text } : {}),
          ...(input.isTask != null ? { isTask: input.isTask } : {}),
          ...(input.completed != null ? { completed: input.completed } : {}),
          ...(input.collapsed != null ? { collapsed: input.collapsed } : {}),
          // `"bullet"` is the explicit reset; the stored field is nullable.
          ...(input.kind != null
            ? {
                kind:
                  input.kind === "paragraph" ? ("paragraph" as const) : null,
              }
            : {}),
        };
        if (!Object.keys(changes).length) {
          return yield* Effect.fail(
            new ToolError({
              reason:
                "nothing to change — pass at least one of text, isTask, completed, collapsed, kind",
            }),
          );
        }
        const index = yield* loadIndex(store);
        const scaffold = yield* loadDailyReverseMap(store);
        yield* guardScaffoldUpdate(index, scaffold, input.nodeId, changes);
        const timestamp = yield* clock;
        const plan = yield* unwrap(
          planUpdateNode(index, { nodeId: input.nodeId, changes, timestamp }),
        );
        yield* commit(store, plan.ops);
        return `Updated ${Object.keys(changes).join(", ")} on node ${input.nodeId}.`;
      }),
  },
  {
    name: "delete_node",
    description:
      "Delete a node and its whole subtree. This cannot be undone by the agent.",
    input: DeleteNodeInput,
    readOnly: false,
    handle: (input: typeof DeleteNodeInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store);
        const scaffold = yield* loadDailyReverseMap(store);
        const timestamp = yield* clock;
        const plan = yield* unwrap(
          planDeleteNode(index, input.nodeId, timestamp),
        );
        yield* guardScaffoldDelete(scaffold, plan.deletedIds);
        yield* commit(store, plan.ops);
        return `Deleted ${plan.deletedIds.length} node(s) (node ${input.nodeId} and its subtree).`;
      }),
  },
  {
    name: "move_nodes",
    description:
      "Move existing nodes (each with its subtree) under a new parent, or to the top level. Preserves node ids, mirrors, and all state — it reorganizes, it never recreates. The order you pass nodeIds is kept.",
    input: MoveNodesInput,
    readOnly: false,
    handle: (input: typeof MoveNodesInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store);
        const timestamp = yield* clock;
        const position = input.position ?? "last";
        const plan = yield* unwrap(
          planReparent(index, {
            nodeIds: input.nodeIds,
            newParentId: input.newParentId ?? null,
            position,
            timestamp,
          }),
        );
        yield* commit(store, plan.ops);
        // An empty plan committed nothing (no nodes given, or every node was
        // already exactly where asked) — say so rather than claim a phantom move.
        if (plan.ops.length === 0) {
          return input.nodeIds.length === 0
            ? "No nodes to move."
            : "No change — the node(s) are already in that position.";
        }
        const where = plan.parentId
          ? `under "${redactSpoilers(index.byId.get(plan.parentId)?.text ?? plan.parentId)}" (id: ${plan.parentId})`
          : "to the top level";
        const noun = plan.parentId ? "children" : "items";
        const pos =
          position === "first" ? `as the first ${noun}` : `as the last ${noun}`;
        return `Moved ${plan.movedIds.length} node(s) ${where} ${pos}.`;
      }),
  },
  {
    name: "add_to_today",
    description:
      "Add a new bullet to the user's daily note, creating today's note (and the Daily container) if needed. One of the fastest ways to capture something for the user.",
    input: AddToTodayInput,
    readOnly: false,
    handle: (input: typeof AddToTodayInput.Type, store, origin) =>
      Effect.gen(function* () {
        const dateKey = yield* resolveDateKey(input.date);
        const scaffold = yield* claimDailyScaffold(store, dateKey);
        // Reuse the index claimDailyScaffold already built -- only kv claims ran
        // since, so a reload would rebuild the identical tree (finding 6).
        const index = scaffold.index;
        const timestamp = yield* clock;
        const plan = planAddToDaily(index, {
          dateKey,
          ...scaffold,
          newNodeId: createId(),
          text: input.text,
          isTask: input.isTask ?? false,
          kind: input.kind ?? null,
          origin,
          timestamp,
        });
        yield* commit(store, plan.ops);
        return `Added "${input.text}" to ${formatDayText(dateKey)} (node id: ${plan.nodeId}, daily note id: ${scaffold.dayId}).`;
      }),
  },
  {
    name: "mirror_node",
    description:
      "Mirror a node (a live synced instance, like a Notion synced block) into another parent — the node appears in both places and edits sync. Omit parentId to mirror to the top level.",
    input: MirrorNodeInput,
    readOnly: false,
    handle: (input: typeof MirrorNodeInput.Type, store, origin) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store);
        const timestamp = yield* clock;
        const plan = yield* unwrap(
          planMirrorNode(index, {
            sourceId: input.nodeId,
            targetParentId: input.parentId ?? null,
            id: createId(),
            origin,
            timestamp,
          }),
        );
        yield* commit(store, plan.ops);
        const where = input.parentId
          ? `under "${redactSpoilers(index.byId.get(trueSourceOf(index, input.parentId))?.text ?? input.parentId)}"`
          : "at the top level";
        return `Mirrored node ${plan.sourceId} ${where} (mirror id: ${plan.nodeId}).`;
      }),
  },
  {
    name: "mirror_to_today",
    description:
      "Mirror an existing node onto the user's daily note — it stays where it is AND appears under today, fully synced. Creates today's note if needed.",
    input: MirrorToTodayInput,
    readOnly: false,
    handle: (input: typeof MirrorToTodayInput.Type, store, origin) =>
      Effect.gen(function* () {
        const dateKey = yield* resolveDateKey(input.date);
        const scaffold = yield* claimDailyScaffold(store, dateKey);
        // Reuse the index claimDailyScaffold already built -- only kv claims ran
        // since, so a reload would rebuild the identical tree (finding 6).
        const index = scaffold.index;
        const timestamp = yield* clock;
        const plan = yield* unwrap(
          planMirrorToDaily(index, {
            dateKey,
            ...scaffold,
            sourceId: input.nodeId,
            mirrorId: createId(),
            origin,
            timestamp,
          }),
        );
        yield* commit(store, plan.ops);
        return `Mirrored node ${plan.sourceId} onto ${formatDayText(dateKey)} (mirror id: ${plan.nodeId}, daily note id: ${scaffold.dayId}).`;
      }),
  },
  {
    name: "import_opml",
    description:
      "Import an OPML document (e.g. a Workflowy export) as new bullets — under a parent (parentId), onto the user's daily note (date), or at the top level. Lands as ONE atomic batch and returns a compact receipt (root ids, counts, any fidelity degradations), never the echoed outline. Ceiling: 5,000 nodes — a full Workflowy migration belongs in the app's own OPML import. Pass dryRun to preview the receipt without writing.",
    input: ImportOpmlInput,
    readOnly: false,
    handle: (input: typeof ImportOpmlInput.Type, store, origin) =>
      Effect.gen(function* () {
        if (input.parentId != null && input.date != null) {
          return yield* Effect.fail(
            new ToolError({ reason: "pass either parentId or date, not both" }),
          );
        }
        const dryRun = input.dryRun ?? false;
        // The shared core (src/data/opml-import.ts) owns parse + mapping +
        // degradation counting — this handler is a thin shell over it, so the
        // MCP surface can't drift from the app importer (ADR 0037).
        const { forest, report } = yield* parseOpml(input.opml).pipe(
          Effect.mapError((e) => new ToolError({ reason: e.message })),
        );
        // Ceiling + emptiness BEFORE any kv claim or plan (the add_subtree
        // guard-before-claim rule, ADR 0028) — counted post-split by the shared
        // core, so the two surfaces can't disagree on what "too big" means.
        if (report.nodesPost === 0) {
          return yield* Effect.fail(
            new ToolError({
              reason: "the OPML document contains no outline nodes",
            }),
          );
        }
        if (report.nodesPost > OPML_MCP_MAX_NODES) {
          return yield* Effect.fail(
            new ToolError({
              reason: `too many nodes to import: ${report.nodesPost} exceeds the ${OPML_MCP_MAX_NODES}-node ceiling for import_opml — for a large or full migration, use the app's own OPML import instead`,
            }),
          );
        }
        const timestamp = yield* clock;
        const rootTexts = forest.map((n) => n.text);

        // Daily path (mirrors add_subtree's date targeting: always appends).
        if (input.date != null) {
          const dateKey = yield* resolveDateKey(input.date);
          if (dryRun) {
            // A dry run must not claim daily-index ids (a kv claim IS a write);
            // plan against a detached parent purely for the receipt's counts.
            const plan = yield* unwrap(
              planOpmlImport(forest, {
                parentId: null,
                firstPrev: null,
                origin,
                timestamp,
                newId: createId,
                maxNodes: OPML_MCP_MAX_NODES,
              }),
            );
            return renderImportReceipt({
              report,
              rootIds: plan.rootIds,
              rootTexts,
              landing: `onto ${formatDayText(dateKey)}`,
              dryRun: true,
            });
          }
          const scaffold = yield* claimDailyScaffold(store, dateKey);
          // Reuse the index claimDailyScaffold already built -- only kv claims ran
          // since, so a reload would rebuild the identical tree (finding 6).
          const index = scaffold.index;
          const ensure = planEnsureDaily(index, {
            dateKey,
            ...scaffold,
            timestamp,
          });
          const siblings = index.byId.has(scaffold.dayId)
            ? childrenOf(index, scaffold.dayId)
            : [];
          const firstPrev = siblings.length
            ? siblings[siblings.length - 1]!.id
            : null;
          const plan = yield* unwrap(
            planOpmlImport(forest, {
              parentId: scaffold.dayId,
              firstPrev,
              origin,
              timestamp,
              newId: createId,
              maxNodes: OPML_MCP_MAX_NODES,
            }),
          );
          yield* commit(store, [...ensure.ops, ...plan.ops]);
          return renderImportReceipt({
            report,
            rootIds: plan.rootIds,
            rootTexts,
            landing: `onto ${formatDayText(dateKey)} (daily note id: ${scaffold.dayId})`,
            dryRun: false,
          });
        }

        // Parent (or top-level) path. No synthetic wrapper container — the
        // fresh-container rule is app-UI presentation, not data semantics.
        const index = yield* loadIndex(store);
        let parentId: string | null = null;
        if (input.parentId != null) {
          if (!index.byId.has(input.parentId)) {
            return yield* Effect.fail(
              new ToolError({ reason: `node not found: ${input.parentId}` }),
            );
          }
          parentId = trueSourceOf(index, input.parentId);
        }
        const siblings = childrenOf(index, parentId);
        const firstPrev = siblings.length
          ? siblings[siblings.length - 1]!.id
          : null;
        const plan = yield* unwrap(
          planOpmlImport(forest, {
            parentId,
            firstPrev,
            origin,
            timestamp,
            newId: createId,
            maxNodes: OPML_MCP_MAX_NODES,
          }),
        );
        if (!dryRun) yield* commit(store, plan.ops);
        const landing = parentId
          ? `under "${redactSpoilers(index.byId.get(parentId)?.text ?? parentId)}" (id: ${parentId})`
          : "at the top level";
        return renderImportReceipt({
          report,
          rootIds: plan.rootIds,
          rootTexts,
          landing,
          dryRun,
        });
      }),
  },
  {
    name: "export_opml",
    description:
      "Export the outline (or one node and its whole subtree via nodeId) as an OPML 2.0 document in the Workflowy dialect. Returns the raw OPML string with no preamble. Ceiling: 5,000 nodes — pass nodeId to scope a large outline.",
    input: ExportOpmlInput,
    readOnly: true,
    handle: (input: typeof ExportOpmlInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store);
        const rootId = input.nodeId ?? null;
        if (rootId !== null && !index.byId.has(rootId)) {
          return yield* Effect.fail(
            new ToolError({ reason: `node not found: ${rootId}` }),
          );
        }
        // The same walk the serializer performs (mirror windows included, cycle
        // caps identical) sizes the scope; over the ceiling the WHOLE call is
        // refused — truncated OPML that still parses is silent loss (ADR 0037).
        const flat = yield* unwrap(
          flattenSubtree(index, rootId, {
            maxDepth: Number.POSITIVE_INFINITY,
            maxNodes: Number.POSITIVE_INFINITY,
          }),
        );
        if (flat.lines.length > OPML_MCP_MAX_NODES) {
          return yield* Effect.fail(
            new ToolError({
              reason: `the export scope holds ${flat.lines.length} nodes, over the ${OPML_MCP_MAX_NODES}-node ceiling for export_opml — pass a nodeId to export a smaller subtree, or use the app's own OPML export for the whole outline`,
            }),
          );
        }
        const rootNode =
          rootId !== null ? index.byId.get(trueSourceOf(index, rootId)) : null;
        // MCP egress: redact spoilers before serializing (ADR 0043). Redact the
        // title too -- a spoiler-bearing root node's text becomes the <title>.
        // The shared exportOpml walk stays verbatim; it's fed a redacted index.
        const title = rootNode?.text.trim()
          ? redactSpoilers(rootNode.text)
          : "dotflowy";
        return exportOpml(redactSpoilerIndex(index), rootId, { title });
      }),
  },
];
