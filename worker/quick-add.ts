/**
 * Headless quick-capture: plan + commit a single bullet for `POST /api/quick-add`.
 * Reuses the same pure planners + daily-index claims as the MCP tools so
 * semantics can't drift (issue #96).
 */

import { Data, Effect, Schema } from 'effect'
import { createId } from '../src/data/tree'
import type { OutlineStore } from './mcp-tools'
import {
  buildTreeIndex,
  isValidDateKey,
  planAddNode,
  planAddToDaily,
} from './outline-ops'

export class QuickAddError extends Data.TaggedError('QuickAddError')<{
  reason: string
  status: 400 | 404
}> {
  get message() {
    return this.reason
  }
}

const KV_DAILY = 'daily-index'
const CONTAINER_KEY = 'container'
const DailyRowSchema = Schema.Struct({ key: Schema.String, nodeId: Schema.String })

const claimDailyId = (
  store: OutlineStore,
  key: string,
  candidate: string,
): Effect.Effect<string, QuickAddError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.promise(() =>
      Promise.resolve(store.getOrCreateKv(KV_DAILY, key, { key, nodeId: candidate })),
    )
    const row = yield* Schema.decodeUnknownEffect(DailyRowSchema)(raw).pipe(
      Effect.mapError(
        () =>
          new QuickAddError({
            reason: `daily index row for "${key}" is malformed`,
            status: 400,
          }),
      ),
    )
    return row.nodeId
  })

const resolveDateKey = (date: string | null | undefined): Effect.Effect<string, QuickAddError> =>
  date == null
    ? Effect.sync(() => new Date().toISOString().slice(0, 10))
    : isValidDateKey(date)
      ? Effect.succeed(date)
      : Effect.fail(
          new QuickAddError({
            reason: `invalid date "${date}" — expected a real YYYY-MM-DD`,
            status: 400,
          }),
        )

export interface QuickAddInput {
  text: string
  parentId?: string | null
  /** Local calendar day when defaulting to daily; UTC today if omitted (MCP parity). */
  date?: string | null
}

export interface QuickAddResult {
  id: string
  parentId: string | null
  seq: number
}

/**
 * Append one bullet under `parentId`, or under the daily note when parent is
 * omitted. Returns the new node id, resolved parent, and the DO batch seq.
 */
export function runQuickAdd(
  store: OutlineStore,
  input: QuickAddInput,
): Effect.Effect<QuickAddResult, QuickAddError> {
  return Effect.gen(function* () {
    const text = input.text.trim()
    if (!text) {
      return yield* Effect.fail(
        new QuickAddError({ reason: 'text is required', status: 400 }),
      )
    }

    const timestamp = Date.now()
    const newId = createId()

    if (input.parentId) {
      const index = yield* Effect.promise(async () =>
        buildTreeIndex(await store.getNodes()),
      )
      const plan = planAddNode(index, {
        id: newId,
        text,
        parentId: input.parentId,
        position: 'last',
        isTask: false,
        origin: 'quick-add',
        timestamp,
      })
      if (plan instanceof Error) {
        return yield* Effect.fail(
          new QuickAddError({ reason: plan.message, status: 404 }),
        )
      }
      const seq = yield* Effect.promise(async () => {
        if (plan.ops.length) return await store.applyBatch(plan.ops)
        return 0
      })
      return { id: plan.nodeId, parentId: plan.parentId, seq }
    }

    // Default destination = daily note (UTC today unless `date` is passed).
    const dateKey = yield* resolveDateKey(input.date)
    const containerId = yield* claimDailyId(store, CONTAINER_KEY, createId())
    const dayId = yield* claimDailyId(store, dateKey, createId())
    const index = yield* Effect.promise(async () =>
      buildTreeIndex(await store.getNodes()),
    )
    const plan = planAddToDaily(index, {
      dateKey,
      containerId,
      dayId,
      newNodeId: newId,
      text,
      isTask: false,
      origin: 'quick-add',
      timestamp,
    })
    const seq = yield* Effect.promise(async () => {
      if (plan.ops.length) return await store.applyBatch(plan.ops)
      return 0
    })
    return { id: plan.nodeId, parentId: dayId, seq }
  })
}
