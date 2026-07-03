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

import { Data, Effect, Schema } from 'effect'
import { createId } from '../src/data/tree'
import type { ChangeOp, Node } from '../src/data/wire-schema'
import {
  DAILY_CONTAINER_TEXT,
  type TreeIndex,
  buildTreeIndex,
  flattenSubtree,
  formatDayText,
  isValidDateKey,
  formatOutlineLines,
  planAddNode,
  planAddToDaily,
  planDeleteNode,
  planMirrorNode,
  planMirrorToDaily,
  planUpdateNode,
  searchNodes,
  trueSourceOf,
} from './outline-ops'

// Re-exported so worker/index.ts can hand the DO stub over without importing
// the planner module directly.
export type { ChangeOp, Node }

/**
 * The slice of the per-user DO a tool needs. `DurableObjectStub<UserOutlineDO>`
 * satisfies it structurally (stub RPC methods return Promises; the sync returns
 * cover an in-process fake in tests).
 */
export interface OutlineStore {
  getNodes(): Node[] | Promise<Node[]>
  applyBatch(ops: readonly ChangeOp[]): number | Promise<number>
  getKv(collection: string): unknown[] | Promise<unknown[]>
  getOrCreateKv(collection: string, key: string, value: unknown): unknown | Promise<unknown>
}

/** A tool execution failure — surfaces as an `isError` tool result (the MCP
 *  shape for "the tool ran and refused"), never a protocol-level error. */
export class ToolError extends Data.TaggedError('ToolError')<{ reason: string }> {
  get message() {
    return this.reason
  }
}

export interface ToolDef {
  name: string
  description: string
  /** Input contract; also the source of the published JSON Schema. */
  input: Schema.Struct<any>
  /** MCP `readOnlyHint` — true for tools that never write. */
  readOnly: boolean
  handle: (input: any, store: OutlineStore) => Effect.Effect<string, ToolError>
}

// --- Shared plumbing ----------------------------------------------------------

const loadIndex = (store: OutlineStore): Effect.Effect<TreeIndex> =>
  Effect.promise(async () => buildTreeIndex(await store.getNodes()))

const commit = (store: OutlineStore, ops: ReadonlyArray<ChangeOp>): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (ops.length) await store.applyBatch(ops)
  })

/** Lift a planner's value-shaped failure into the tool error channel,
 *  narrowing the success side (the planners' errors all extend `Error`). */
const unwrap = <A>(result: A): Effect.Effect<Exclude<A, Error>, ToolError> =>
  result instanceof Error
    ? Effect.fail(new ToolError({ reason: result.message }))
    : Effect.succeed(result as Exclude<A, Error>)

const clock = Effect.sync(() => Date.now())

// --- Daily-index claims -------------------------------------------------------

const KV_DAILY = 'daily-index'
const CONTAINER_KEY = 'container'

const DailyRowSchema = Schema.Struct({ key: Schema.String, nodeId: Schema.String })

/** Atomically claim `key -> candidate` in the daily index and return the
 *  authoritative winner — the DO-side twin of the client's `claimMapping`. */
const claimDailyId = (
  store: OutlineStore,
  key: string,
  candidate: string,
): Effect.Effect<string, ToolError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.promise(() =>
      Promise.resolve(store.getOrCreateKv(KV_DAILY, key, { key, nodeId: candidate })),
    )
    const row = yield* Schema.decodeUnknownEffect(DailyRowSchema)(raw).pipe(
      Effect.mapError(() => new ToolError({ reason: `daily index row for "${key}" is malformed` })),
    )
    return row.nodeId
  })

/** The daily container's node id, if one has been claimed (no side effects). */
const containerIdOf = (store: OutlineStore): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const rows = yield* Effect.promise(() => Promise.resolve(store.getKv(KV_DAILY)))
    for (const raw of rows) {
      const row = Schema.decodeUnknownOption(DailyRowSchema)(raw)
      if (row._tag === 'Some' && row.value.key === CONTAINER_KEY) return row.value.nodeId
    }
    return null
  })

/** Resolve the tool's optional `date` input to a valid `YYYY-MM-DD` key. The
 *  default is the server's UTC today — tools advertise that callers should pass
 *  the user's local date, since the Worker can't know their timezone. */
const resolveDateKey = (date: string | null | undefined): Effect.Effect<string, ToolError> =>
  date == null
    ? Effect.sync(() => new Date().toISOString().slice(0, 10))
    : isValidDateKey(date)
      ? Effect.succeed(date)
      : Effect.fail(new ToolError({ reason: `invalid date "${date}" — expected a real YYYY-MM-DD` }))

// --- Protection (ADR 0015, server-enforced) -----------------------------------

const guardContainerDelete = (
  containerId: string | null,
  deletedIds: ReadonlyArray<string>,
): Effect.Effect<void, ToolError> =>
  containerId && deletedIds.includes(containerId)
    ? Effect.fail(
        new ToolError({
          reason: `the "${DAILY_CONTAINER_TEXT}" container is protected and can't be deleted`,
        }),
      )
    : Effect.void

const guardContainerUpdate = (
  index: TreeIndex,
  containerId: string | null,
  nodeId: string,
  changes: { text?: string; isTask?: boolean; completed?: boolean },
): Effect.Effect<void, ToolError> => {
  if (!containerId) return Effect.void
  if (!index.byId.has(nodeId)) return Effect.void
  if (trueSourceOf(index, nodeId) !== containerId && nodeId !== containerId) return Effect.void
  const violation =
    changes.text !== undefined && !changes.text.trim()
      ? "blanked (it's how daily notes are found)"
      : changes.isTask
        ? 'made a to-do'
        : changes.completed
          ? 'completed'
          : null
  return violation
    ? Effect.fail(
        new ToolError({
          reason: `the "${DAILY_CONTAINER_TEXT}" container is protected and can't be ${violation}`,
        }),
      )
    : Effect.void
}

// --- Input schemas ------------------------------------------------------------
// `Schema.optional(Schema.NullOr(...))` throughout: the published JSON Schema
// advertises `T | null`, and the decoder accepts BOTH an omitted key and an
// explicit null — agents routinely send either.

const optional = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

const GetOutlineInput = Schema.Struct({
  nodeId: optional(
    Schema.String.annotate({
      description: 'Root node to read from. Omit to read the whole outline from the top level.',
    }),
  ),
  maxDepth: optional(
    Schema.Int.annotate({
      description: 'How many levels deep to read (default: unlimited).',
    }),
  ),
})

const SearchNodesInput = Schema.Struct({
  query: Schema.String.annotate({
    description: 'Case-insensitive text to find in node text.',
  }),
})

const AddNodeInput = Schema.Struct({
  text: Schema.String.annotate({ description: 'The bullet text.' }),
  parentId: optional(
    Schema.String.annotate({
      description: 'Parent node id. Omit to add at the top level.',
    }),
  ),
  position: optional(
    Schema.Literals(['first', 'last']).annotate({
      description: 'Insert as the first or last child (default: last).',
    }),
  ),
  isTask: optional(
    Schema.Boolean.annotate({ description: 'Create as a to-do with a checkbox (default: false).' }),
  ),
})

const UpdateNodeInput = Schema.Struct({
  nodeId: Schema.String.annotate({ description: 'The node to update.' }),
  text: optional(Schema.String.annotate({ description: 'New bullet text.' })),
  isTask: optional(
    Schema.Boolean.annotate({ description: 'Turn the checkbox on (true) or off (false).' }),
  ),
  completed: optional(
    Schema.Boolean.annotate({ description: 'Mark done (true) or not done (false).' }),
  ),
  collapsed: optional(
    Schema.Boolean.annotate({ description: 'Collapse (true) or expand (false) the bullet.' }),
  ),
})

const DeleteNodeInput = Schema.Struct({
  nodeId: Schema.String.annotate({
    description: 'The node to delete. Its whole subtree is deleted with it.',
  }),
})

const dateField = optional(
  Schema.String.annotate({
    description:
      "The day's date as YYYY-MM-DD. Pass the user's local date; defaults to today in UTC.",
  }),
)

const AddToTodayInput = Schema.Struct({
  text: Schema.String.annotate({ description: 'The bullet text to add to the daily note.' }),
  isTask: optional(
    Schema.Boolean.annotate({ description: 'Create as a to-do with a checkbox (default: false).' }),
  ),
  date: dateField,
})

const MirrorNodeInput = Schema.Struct({
  nodeId: Schema.String.annotate({ description: 'The node to mirror (its subtree comes with it).' }),
  parentId: optional(
    Schema.String.annotate({
      description: 'Where to put the mirror. Omit to mirror to the top level.',
    }),
  ),
})

const MirrorToTodayInput = Schema.Struct({
  nodeId: Schema.String.annotate({ description: 'The node to mirror onto the daily note.' }),
  date: dateField,
})

// --- The tools ----------------------------------------------------------------

const MAX_OUTLINE_NODES = 500
const MAX_SEARCH_HITS = 25

export const tools: ReadonlyArray<ToolDef> = [
  {
    name: 'get_outline',
    description:
      'Read the outline (or one node and its subtree) as an indented bullet list. Every line carries its node id — use those ids with the other tools.',
    input: GetOutlineInput,
    readOnly: true,
    handle: (input: typeof GetOutlineInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store)
        const result = yield* unwrap(
          flattenSubtree(index, input.nodeId ?? null, {
            maxDepth: input.maxDepth ?? Number.POSITIVE_INFINITY,
            maxNodes: MAX_OUTLINE_NODES,
          }),
        )
        if (!result.lines.length) return 'The outline is empty.'
        const body = formatOutlineLines(result.lines)
        return result.truncated
          ? `${body}\n\n(truncated at ${MAX_OUTLINE_NODES} nodes — read a subtree via nodeId for more)`
          : body
      }),
  },
  {
    name: 'search_nodes',
    description:
      'Find nodes by text (case-insensitive substring). Returns each match with its id and breadcrumb path.',
    input: SearchNodesInput,
    readOnly: true,
    handle: (input: typeof SearchNodesInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store)
        const hits = searchNodes(index, input.query, MAX_SEARCH_HITS)
        if (!hits.length) return `No nodes match "${input.query}".`
        const body = hits
          .map((h) => {
            const path = h.path.length ? ` — in: ${h.path.join(' > ')}` : ''
            return `- "${h.text}" (id: ${h.id})${path}`
          })
          .join('\n')
        return hits.length >= MAX_SEARCH_HITS ? `${body}\n\n(first ${MAX_SEARCH_HITS} matches)` : body
      }),
  },
  {
    name: 'add_node',
    description:
      'Add a new bullet to the outline — under a parent node or at the top level. Returns the new node id.',
    input: AddNodeInput,
    readOnly: false,
    handle: (input: typeof AddNodeInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store)
        const timestamp = yield* clock
        const plan = yield* unwrap(
          planAddNode(index, {
            id: createId(),
            text: input.text,
            parentId: input.parentId ?? null,
            position: input.position ?? 'last',
            isTask: input.isTask ?? false,
            timestamp,
          }),
        )
        yield* commit(store, plan.ops)
        const where = plan.parentId
          ? `under "${index.byId.get(plan.parentId)?.text ?? plan.parentId}"`
          : 'at the top level'
        return `Added "${input.text}" ${where} (id: ${plan.nodeId}).`
      }),
  },
  {
    name: 'update_node',
    description:
      "Edit a node's text, to-do state, done state, or collapsed state. Editing a mirror edits the shared content everywhere it appears.",
    input: UpdateNodeInput,
    readOnly: false,
    handle: (input: typeof UpdateNodeInput.Type, store) =>
      Effect.gen(function* () {
        const changes = {
          ...(input.text != null ? { text: input.text } : {}),
          ...(input.isTask != null ? { isTask: input.isTask } : {}),
          ...(input.completed != null ? { completed: input.completed } : {}),
          ...(input.collapsed != null ? { collapsed: input.collapsed } : {}),
        }
        if (!Object.keys(changes).length) {
          return yield* Effect.fail(
            new ToolError({
              reason: 'nothing to change — pass at least one of text, isTask, completed, collapsed',
            }),
          )
        }
        const index = yield* loadIndex(store)
        const containerId = yield* containerIdOf(store)
        yield* guardContainerUpdate(index, containerId, input.nodeId, changes)
        const timestamp = yield* clock
        const plan = yield* unwrap(planUpdateNode(index, { nodeId: input.nodeId, changes, timestamp }))
        yield* commit(store, plan.ops)
        return `Updated ${Object.keys(changes).join(', ')} on node ${input.nodeId}.`
      }),
  },
  {
    name: 'delete_node',
    description: 'Delete a node and its whole subtree. This cannot be undone by the agent.',
    input: DeleteNodeInput,
    readOnly: false,
    handle: (input: typeof DeleteNodeInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store)
        const containerId = yield* containerIdOf(store)
        const timestamp = yield* clock
        const plan = yield* unwrap(planDeleteNode(index, input.nodeId, timestamp))
        yield* guardContainerDelete(containerId, plan.deletedIds)
        yield* commit(store, plan.ops)
        return `Deleted ${plan.deletedIds.length} node(s) (node ${input.nodeId} and its subtree).`
      }),
  },
  {
    name: 'add_to_today',
    description:
      "Add a new bullet to the user's daily note, creating today's note (and the Daily container) if needed. One of the fastest ways to capture something for the user.",
    input: AddToTodayInput,
    readOnly: false,
    handle: (input: typeof AddToTodayInput.Type, store) =>
      Effect.gen(function* () {
        const dateKey = yield* resolveDateKey(input.date)
        const containerId = yield* claimDailyId(store, CONTAINER_KEY, createId())
        const dayId = yield* claimDailyId(store, dateKey, createId())
        const index = yield* loadIndex(store)
        const timestamp = yield* clock
        const plan = planAddToDaily(index, {
          dateKey,
          containerId,
          dayId,
          newNodeId: createId(),
          text: input.text,
          isTask: input.isTask ?? false,
          timestamp,
        })
        yield* commit(store, plan.ops)
        return `Added "${input.text}" to ${formatDayText(dateKey)} (node id: ${plan.nodeId}, daily note id: ${dayId}).`
      }),
  },
  {
    name: 'mirror_node',
    description:
      'Mirror a node (a live synced instance, like a Notion synced block) into another parent — the node appears in both places and edits sync. Omit parentId to mirror to the top level.',
    input: MirrorNodeInput,
    readOnly: false,
    handle: (input: typeof MirrorNodeInput.Type, store) =>
      Effect.gen(function* () {
        const index = yield* loadIndex(store)
        const timestamp = yield* clock
        const plan = yield* unwrap(
          planMirrorNode(index, {
            sourceId: input.nodeId,
            targetParentId: input.parentId ?? null,
            id: createId(),
            timestamp,
          }),
        )
        yield* commit(store, plan.ops)
        const where = input.parentId
          ? `under "${index.byId.get(trueSourceOf(index, input.parentId))?.text ?? input.parentId}"`
          : 'at the top level'
        return `Mirrored node ${plan.sourceId} ${where} (mirror id: ${plan.nodeId}).`
      }),
  },
  {
    name: 'mirror_to_today',
    description:
      "Mirror an existing node onto the user's daily note — it stays where it is AND appears under today, fully synced. Creates today's note if needed.",
    input: MirrorToTodayInput,
    readOnly: false,
    handle: (input: typeof MirrorToTodayInput.Type, store) =>
      Effect.gen(function* () {
        const dateKey = yield* resolveDateKey(input.date)
        const containerId = yield* claimDailyId(store, CONTAINER_KEY, createId())
        const dayId = yield* claimDailyId(store, dateKey, createId())
        const index = yield* loadIndex(store)
        const timestamp = yield* clock
        const plan = yield* unwrap(
          planMirrorToDaily(index, {
            dateKey,
            containerId,
            dayId,
            sourceId: input.nodeId,
            mirrorId: createId(),
            timestamp,
          }),
        )
        yield* commit(store, plan.ops)
        return `Mirrored node ${plan.sourceId} onto ${formatDayText(dateKey)} (mirror id: ${plan.nodeId}, daily note id: ${dayId}).`
      }),
  },
]
