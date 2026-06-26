import { useCallback, useSyncExternalStore } from 'react'
import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { z } from 'zod'
import { queryClient } from '../../data/query-client'
import { resyncNodes } from '../../data/collection'
import {
  kvDelete,
  kvFetch,
  kvGetOrCreate,
  kvPut,
  toKvKeys,
  toKvRows,
} from '../../data/kv-api'

/**
 * The daily index -- the *identity* of a daily note (ADR 0019). A row maps a
 * key to a node id:
 *  - key `YYYY-MM-DD` (local date)  -> that day's note node
 *  - key `"container"` (sentinel)   -> the single "Daily" container node
 *
 * Why a side-collection, not a `Node` field or parsed text: a day must be
 * machine-addressable ("the node for 2026-06-23"), and that identity can't live
 * in mutable text (Seam A's tags/links derive from text precisely because their
 * identity *is* the text). Seam E keeps it off the `Node` schema. A sibling of
 * `nodesCollection`, backed by D1 through the generic /api/kv store (ADR 0024),
 * so daily-note identity syncs across devices.
 *
 * Mirrors `tag-colors.ts`: a D1-backed kv collection plus a
 * `subscribeChanges`/`useSyncExternalStore` reactive read (NOT `useLiveQuery`,
 * which hard-fails the `/` prerender -- ADR 0004).
 */

/** Sentinel key for the container row (not a valid `YYYY-MM-DD`, so no clash). */
export const CONTAINER_KEY = 'container'

const dailyRowSchema = z.object({
  /** `YYYY-MM-DD` (local) for a day, or {@link CONTAINER_KEY}. */
  key: z.string(),
  /** The node this key points at. */
  nodeId: z.string(),
})

export type DailyRow = z.infer<typeof dailyRowSchema>

const KV = 'daily-index'

export const dailyIndexCollection = createCollection(
  queryCollectionOptions({
    id: 'daily-index',
    queryKey: ['kv', KV],
    queryClient,
    queryFn: () => kvFetch<DailyRow>(KV),
    getKey: (row: DailyRow) => row.key,
    schema: dailyRowSchema,
    // Insert and update both upsert the whole row (tiny key->value items).
    onInsert: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction))
      return { refetch: false }
    },
    onUpdate: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction))
      return { refetch: false }
    },
    onDelete: async ({ transaction }) => {
      await kvDelete(KV, toKvKeys(transaction))
      return { refetch: false }
    },
  }),
)

// --- Date helpers -----------------------------------------------------------

/**
 * Local-time date key `YYYY-MM-DD`. Deliberately NOT `toISOString` (that's UTC):
 * the day boundary is the user's local midnight (SPA, no server clock -- ADR
 * 0004).
 */
export function localDateKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse a `YYYY-MM-DD` key to a *local* Date at noon (a TZ-safe midpoint that
 *  never slips a day under DST). Null on a malformed key. */
function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
}

/** The full, human date used to seed a day node's text + feed Cmd+K search,
 *  e.g. "Tuesday, June 23, 2026". */
export function formatDayText(key: string): string {
  const d = parseDateKey(key)
  if (!d) return key
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/** The *relative* label for a day key -- Today / Yesterday / Tomorrow -- or null
 *  for anything further out. Null (not a short date) on purpose: a date is
 *  redundant next to the seeded full-date text, so callers that annotate the
 *  date (the Cmd+K result, Seam J) want only the genuinely-additive relatives. */
export function formatDayRelative(
  key: string,
  today = localDateKey(),
): string | null {
  const d = parseDateKey(key)
  const t = parseDateKey(today)
  if (!d || !t) return null
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === -1) return 'Yesterday'
  if (diff === 1) return 'Tomorrow'
  return null
}

/** The compact *relative* label for the badge: Today / Yesterday / Tomorrow,
 *  else a short date ("Jun 23"). Complementary to the seeded full-date text, not
 *  a duplicate of it -- it's the "this is a daily note" signifier + quick
 *  orientation. Computed from the key vs today (ADR 0019). */
export function formatDayBadge(key: string, today = localDateKey()): string {
  const rel = formatDayRelative(key, today)
  if (rel) return rel
  const d = parseDateKey(key)
  if (!d) return key
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// --- Non-reactive lookups (click handlers + the protection predicate) -------

function findRow(pred: (r: DailyRow) => boolean): DailyRow | undefined {
  return dailyIndexCollection.toArray.find(pred)
}

/** The container node id, or null if it hasn't been created yet. */
export function getContainerId(): string | null {
  return findRow((r) => r.key === CONTAINER_KEY)?.nodeId ?? null
}

/** The node id mapped to a given date key, or null. */
export function getDayId(key: string): string | null {
  return findRow((r) => r.key === key)?.nodeId ?? null
}

/** Upsert a `key -> nodeId` mapping (used when (re)creating a container/day). */
export function setMapping(key: string, nodeId: string): void {
  if (dailyIndexCollection.toArray.some((r) => r.key === key)) {
    dailyIndexCollection.update(key, (draft) => void (draft.nodeId = nodeId))
  } else {
    dailyIndexCollection.insert({ key, nodeId })
  }
}

/**
 * Atomic, server-authoritative claim of a `key -> nodeId` mapping. Mints nothing
 * itself — the caller supplies a `candidate` node id, and this returns the
 * AUTHORITATIVE winner plus whether this caller won (so it should create the
 * node under `candidate`). Two devices with a stale replica both miss the key
 * locally and both claim; the single-threaded DO lets exactly one win, killing
 * the duplicate-daily-note race at the source.
 *
 * This is the errore boundary over the throwing kv client: on a network/server
 * failure it logs and degrades to the optimistic local path (treats `candidate`
 * as the winner), so the feature keeps working — the rare failure window just
 * reopens the pre-fix race, no worse than before the claim existed.
 */
export async function claimMapping(
  key: string,
  candidate: string,
): Promise<{ winner: string; won: boolean }> {
  const row = await kvGetOrCreate<DailyRow>(KV, key, { key, nodeId: candidate })
    .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (row instanceof Error) {
    console.warn(`daily: claim "${key}" failed, creating locally:`, row.message)
    return { winner: candidate, won: true }
  }
  return { winner: row.nodeId, won: row.nodeId === candidate }
}

/**
 * Reconcile the outline against server truth so a node another device created
 * (the winner of a claim this device lost) becomes locally present before we
 * navigate to it. Triggers a socket resync (a fresh snapshot); best effort -- if
 * the winner's write hasn't reached the server yet it self-heals on the next
 * live delta. With real-time push the winner's insert usually already arrived,
 * so this is a belt-and-suspenders safety net.
 */
export function refetchNodes(): Promise<void> {
  resyncNodes()
  return Promise.resolve()
}

/** True iff `nodeId` is the daily container -- the protection predicate (Seam:
 *  protected nodes). A synchronous read; only ever called on the delete path. */
export function isContainerNode(nodeId: string): boolean {
  return getContainerId() === nodeId
}

/** The date key a node maps to if it's a *day* note (not the container), else
 *  null. The synchronous reverse of {@link getDayId} -- used by the search-alias
 *  seam (Seam J), which runs outside any hook context. */
export function getDayKey(nodeId: string): string | null {
  return findRow((r) => r.nodeId === nodeId && r.key !== CONTAINER_KEY)?.key ?? null
}

// --- Reactive read (mirrors tag-colors.ts; prerender-safe) ------------------

const EMPTY: DailyRow[] = []
let rows: DailyRow[] = EMPTY
const listeners = new Set<() => void>()
let started = false

function rebuild() {
  rows = dailyIndexCollection.toArray
  for (const l of listeners) l()
}

function ensureStarted() {
  if (started || typeof window === 'undefined') return
  started = true
  dailyIndexCollection.subscribeChanges(() => rebuild(), {
    includeInitialState: true,
  })
}

function subscribe(cb: () => void): () => void {
  ensureStarted()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getRows(): DailyRow[] {
  ensureStarted()
  return rows
}

/**
 * The date key this node maps to if it's a *day* note (not the container), else
 * null. Reactive -- the date badge subscribes through this so it appears the
 * moment a day is created. Prerender returns null (empty server snapshot).
 */
export function useDailyDate(nodeId: string): string | null {
  const getSnapshot = useCallback(() => {
    const row = getRows().find(
      (r) => r.nodeId === nodeId && r.key !== CONTAINER_KEY,
    )
    return row ? row.key : null
  }, [nodeId])
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}
