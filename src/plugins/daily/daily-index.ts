import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Effect, Schema } from "effect";
import { useCallback, useSyncExternalStore } from "react";

import { localDateKey } from "../../data/date-links";
import {
  kvDelete,
  kvFetch,
  kvPut,
  toKvKeys,
  toKvRows,
} from "../../data/kv-api";
import { kvGetOrCreateE } from "../../data/kv-client-effect";
import { queryClient } from "../../data/query-client";

/**
 * The daily index -- the *identity* of a daily note (ADR 0001). A row maps a
 * key to a node id:
 *  - key `YYYY-MM-DD` (local date)  -> that day's note node
 *  - key `"container"` (sentinel)   -> the single "Daily" container node
 *
 * Why a side-collection, not a `Node` field or parsed text: a day must be
 * machine-addressable ("the node for 2026-06-23"), and that identity can't live
 * in mutable text (Seam A's tags/links derive from text precisely because their
 * identity *is* the text). Seam E keeps it off the `Node` schema. A sibling of
 * `nodesCollection`, backed by D1 through the generic /api/kv store (ADR 0008),
 * so daily-note identity syncs across devices.
 *
 * Mirrors `tag-colors.ts`: a D1-backed kv collection plus a
 * `subscribeChanges`/`useSyncExternalStore` reactive read (NOT `useLiveQuery`,
 * which hard-fails the `/` prerender -- ADR 0004).
 */

/** Sentinel key for the container row (not a valid `YYYY-MM-DD`, so no clash). */
export const CONTAINER_KEY = "container";

/** Canonical display name of the "Daily" container. Used both when seeding it
 *  and to restore it if a user blanks the row (it's protected, so it can't be
 *  left nameless). Cosmetic -- identity is the side-collection, never the text. */
export const DAILY_CONTAINER_TEXT = "Daily";

const dailyRowSchema = Schema.Struct({
  /** `YYYY-MM-DD` (local) for a day, or {@link CONTAINER_KEY}. */
  key: Schema.String,
  /** The node this key points at. */
  nodeId: Schema.String,
});

export type DailyRow = Schema.Schema.Type<typeof dailyRowSchema>;

const KV = "daily-index";

export const dailyIndexCollection = createCollection(
  queryCollectionOptions({
    id: "daily-index",
    queryKey: ["kv", KV],
    queryClient,
    queryFn: () => kvFetch<DailyRow>(KV),
    getKey: (row: DailyRow) => row.key,
    schema: Schema.toStandardSchemaV1(dailyRowSchema),
    // Insert and update both upsert the whole row (tiny key->value items).
    onInsert: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
    onDelete: async ({ transaction }) => {
      await kvDelete(KV, toKvKeys(transaction));
      return { refetch: false };
    },
  }),
);

// --- Date helpers -----------------------------------------------------------

/**
 * Local-time date key `YYYY-MM-DD`. Deliberately NOT `toISOString` (that's UTC):
 * the day boundary is the user's local midnight (SPA, no server clock -- ADR
 * 0004). The one implementation lives in the pure date-links layer (ADR 0038 --
 * the `[[YYYY-MM-DD]]` token's interior IS this key), re-exported here so the
 * key format can't fork.
 */
export { localDateKey } from "../../data/date-links";

/** Parse a `YYYY-MM-DD` key to a *local* Date at noon (a TZ-safe midpoint that
 *  never slips a day under DST). Null on a malformed key. */
function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

/** The full, human date used to seed a day node's text + feed Cmd+K search,
 *  e.g. "Tuesday, June 23, 2026". */
export function formatDayText(key: string): string {
  const d = parseDateKey(key);
  if (!d) return key;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The *relative* label for a day key -- Today / Yesterday / Tomorrow -- or null
 *  for anything further out. Null (not a short date) on purpose: a date is
 *  redundant next to the seeded full-date text, so callers that annotate the
 *  date (the Cmd+K result, Seam J) want only the genuinely-additive relatives. */
export function formatDayRelative(
  key: string,
  today = localDateKey(),
): string | null {
  const d = parseDateKey(key);
  const t = parseDateKey(today);
  if (!d || !t) return null;
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  return null;
}

/** The compact *relative* label for the badge: Today / Yesterday / Tomorrow,
 *  else a short date ("Jun 23"). Complementary to the seeded full-date text, not
 *  a duplicate of it -- it's the "this is a daily note" signifier + quick
 *  orientation. Computed from the key vs today (ADR 0001). */
export function formatDayBadge(key: string, today = localDateKey()): string {
  const rel = formatDayRelative(key, today);
  if (rel) return rel;
  const d = parseDateKey(key);
  if (!d) return key;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- Non-reactive lookups (click handlers + the protection predicate) -------

// Reads the module `rows` cache (below), NOT `dailyIndexCollection.toArray`:
// the protection predicate runs during render (useIsProtected's synchronous
// getSnapshot), and the cache is the render-safe path `useScaffoldKey` uses. The
// cache is rebuilt synchronously on every collection change (includeInitialState),
// so event-time callers read the same freshness.
function findRow(pred: (r: DailyRow) => boolean): DailyRow | undefined {
  return getRows().find(pred);
}

/** The container node id, or null if it hasn't been created yet. */
export function getContainerId(): string | null {
  return findRow((r) => r.key === CONTAINER_KEY)?.nodeId ?? null;
}

/** The node id mapped to ANY scaffold key -- container / year / month / week /
 *  day (issue #271). The generic reverse of {@link setMapping}, used by the
 *  Daily > Y > M > W > D get-or-create cascade AND to look up a day note by its
 *  date key. */
export function getMappedId(key: string): string | null {
  return findRow((r) => r.key === key)?.nodeId ?? null;
}

/** The daily-index key a node maps to (container / year / month / week / day),
 *  or null when it isn't a scaffold node (issue #271). O(1) off the persistent
 *  reverse map (finding 7): the scaffold protection predicate and every badge
 *  read call this per row, so a linear scan would be O(nodes x dailyRows) on
 *  every render. */
export function getKeyForNode(nodeId: string): string | null {
  ensureStarted();
  return keyByNodeId.get(nodeId) ?? null;
}

/** Upsert a `key -> nodeId` mapping (used when (re)creating a container/day). */
export function setMapping(key: string, nodeId: string): void {
  if (dailyIndexCollection.toArray.some((r) => r.key === key)) {
    dailyIndexCollection.update(key, (draft) => void (draft.nodeId = nodeId));
  } else {
    dailyIndexCollection.insert({ key, nodeId });
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
 * This is the boundary that degrades to a value on failure: on a network/server
 * failure it logs and degrades to the optimistic local path (treats `candidate`
 * as the winner), so the feature keeps working — the rare failure window just
 * reopens the pre-fix race, no worse than before the claim existed.
 *
 * Why Effect here (and throwing everywhere else in the kv path): the TanStack
 * DB mutation handlers signal failure by THROWING (a throw triggers optimistic
 * rollback), so the rest of kv-api.ts stays throw-based on purpose. claimMapping
 * has no TanStack caller — it's an awaitable from a click handler — so it can
 * speak Effect's typed-error channel directly and route with catchTag, proving
 * the ergonomics on real I/O. See kv-client-effect.ts.
 */
export async function claimMapping(
  key: string,
  candidate: string,
): Promise<{ winner: string; won: boolean }> {
  /**
   * Route every typed kv error to a single degraded outcome *inside* the Effect
   * pipeline, then runPromise never rejects — caller sees only plain success.
   * This is the whole point of the Effect boundary: error shape is known at the
   * type level, and the recovery is expressed as a program transform, not a
   * catch-block after the fact.
   */
  const row = await Effect.runPromise(
    kvGetOrCreateE<DailyRow>(KV, key, { key, nodeId: candidate }).pipe(
      Effect.match({
        onFailure: (e) => {
          console.warn(
            `daily: claim "${key}" failed, creating locally:`,
            e.message,
          );
          return { key, nodeId: candidate } satisfies DailyRow;
        },
        onSuccess: (r) => r,
      }),
    ),
  );
  return { winner: row.nodeId, won: row.nodeId === candidate };
}

// --- Reactive read (mirrors tag-colors.ts; prerender-safe) ------------------

const EMPTY: DailyRow[] = [];
let rows: DailyRow[] = EMPTY;
/** Persistent nodeId -> key reverse map, rebuilt in lockstep with `rows`, so
 *  {@link getKeyForNode} is O(1) (finding 7 -- the Worker's `keyByNodeId` twin). */
let keyByNodeId = new Map<string, string>();
const listeners = new Set<() => void>();
let started = false;

function rebuild() {
  rows = dailyIndexCollection.toArray;
  const next = new Map<string, string>();
  for (const r of rows) next.set(r.nodeId, r.key);
  keyByNodeId = next;
  for (const l of listeners) l();
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  dailyIndexCollection.subscribeChanges(() => rebuild(), {
    includeInitialState: true,
  });
}

/** Subscribe to any change in the daily index (rebuilt on every collection
 *  change, including the initial fetch resolving). Drives the reactive date
 *  badge AND the container's protection lock (Seam: `protectsChanged`) -- the
 *  lock must re-render when the `container -> nodeId` mapping arrives, not only
 *  after an unrelated re-render. Returns an unsubscribe. */
export function subscribeDailyIndex(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Start the index's kv fetch eagerly (the plugin `preload` seam, called once
 *  at editor mount). Without this the fetch starts lazily at the FIRST badge/
 *  lock render -- i.e. only after the outline snapshot has already painted --
 *  so the day badges and the container lock popped in a beat later (a layout
 *  shift). Preloading lets the kv fetch race the nodes snapshot instead of
 *  queuing behind it. */
export function preloadDailyIndex(): void {
  ensureStarted();
}

/** Every daily-index mapping (container / year / month / week / day), for the
 *  migration planner's candidate scan (finding 7 -- it filters to day-kind). A
 *  snapshot read off the module cache; safe outside a hook. */
export function getDailyRows(): DailyRow[] {
  return getRows();
}

/**
 * Await the daily index's readiness AND pull the freshest cross-device state
 * before a get-or-create computes placement (finding 4). Two hazards this closes:
 *  - COLD LOAD: `preloadDailyIndex` only STARTS the fetch, so an early daily
 *    touch could see zero mappings -- the migration gate skips (needed=false)
 *    and sorted insertion misplaces. `toArrayWhenReady` blocks until the first
 *    fetch lands.
 *  - CROSS-DEVICE: kv writes are never broadcast (the DO's kv path has no
 *    changelog), so a day created on another device syncs its NODE but not its
 *    MAPPING until a refetch -- leaving `getKeyForNode(sibling) === null` and
 *    sorted insertion silently skipping it. `utils.refetch()` re-pulls the kv.
 * A new-day creation is rare (~once/day), so one kv GET on that path is cheap.
 */
export async function refreshDailyIndex(): Promise<void> {
  ensureStarted();
  // Best-effort: a network failure here must NOT block day creation (the caller
  // proceeds with whatever mappings it has), but a silent swallow hid the cause
  // of a misplaced day (finding 2) -- so warn, don't rethrow.
  await dailyIndexCollection
    .toArrayWhenReady()
    .catch((err) => console.warn("daily: index readiness failed", err));
  await dailyIndexCollection.utils
    .refetch()
    .catch((err) => console.warn("daily: index refetch failed", err));
}

function getRows(): DailyRow[] {
  ensureStarted();
  return rows;
}

/**
 * The scaffold key this node maps to (year / month / week / day -- NOT the
 * container), else null (issue #271). Reactive: the badge component reads this
 * once and dispatches on {@link scaffoldKeyKind}, so a day pill and a week badge
 * both appear the moment their node is minted. Prerender returns null.
 */
export function useScaffoldKey(nodeId: string): string | null {
  const getSnapshot = useCallback(() => {
    // O(1) off the reverse map (finding 7) -- this runs per rendered node, so a
    // linear `rows.find` here was O(nodes x dailyRows) every render.
    const key = getKeyForNode(nodeId);
    return key === null || key === CONTAINER_KEY ? null : key;
  }, [nodeId]);
  return useSyncExternalStore(subscribeDailyIndex, getSnapshot, () => null);
}
