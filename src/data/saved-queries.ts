import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Schema } from "effect";
import { useCallback, useSyncExternalStore } from "react";

import { isLunoraSyncEnabled } from "./flags";
import { kvDelete, kvFetch, kvPut, toKvKeys, toKvRows } from "./kv-api";
import { queryClient } from "./query-client";
import {
  defaultQueryName,
  findSavedQuery,
  isQuerySaved,
  normalizeQuery,
  type SavedQueryRow,
  sortSavedNewestFirst,
} from "./saved-queries-core";

/**
 * Saved filter queries (ADR 0048). A filter worth typing twice is worth saving:
 * a Pin toggle in the filter input stores the `?q=` string here, and it's
 * surfaced in exactly two places -- the filter popover's "Saved" section and the
 * Cmd+K empty state (the bookmark symmetry).
 *
 * Storage is a kv side-collection (`saved-queries` via /api/kv, the tag-colors
 * pattern) -- it rides the per-user DO, syncs across devices, needs no `Node`
 * field. A saved query is user data, not a view preference, so localStorage
 * would strand it per-browser (ADR 0048 decision 1).
 *
 * Mirrors `tag-colors.ts`: a kv query collection plus a
 * `subscribeChanges`/`useSyncExternalStore` reactive read (NOT `useLiveQuery`,
 * which hard-fails the `/` prerender -- ADR 0004).
 */

const savedQuerySchema = Schema.Struct({
  /** Stable row id (the getKey). */
  id: Schema.String,
  /** Display name; defaults to the query text at save time, renameable later. */
  name: Schema.String,
  /** The raw `?q=` filter string. */
  query: Schema.String,
  /** Epoch ms at save time -- the newest-first sort key. */
  createdAt: Schema.Number,
});

export type { SavedQueryRow };

const KV = "saved-queries";

export const savedQueriesCollection = createCollection(
  queryCollectionOptions({
    id: "saved-queries",
    queryKey: ["kv", KV],
    queryClient,
    queryFn: () => kvFetch<SavedQueryRow>(KV),
    getKey: (row: SavedQueryRow) => row.id,
    schema: Schema.toStandardSchemaV1(savedQuerySchema),
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

// --- Mutations --------------------------------------------------------------

type LunoraSavedQueryWrites = {
  list: () => SavedQueryRow[];
  upsert: (row: SavedQueryRow) => void;
  patchName: (id: string, name: string) => void;
  remove: (id: string) => void;
};

let lunoraWrites: LunoraSavedQueryWrites | null = null;

function liveRows(): SavedQueryRow[] {
  if (lunoraWrites) return lunoraWrites.list();
  return savedQueriesCollection.toArray;
}

/** Save the current query, name defaulting to the query text (ADR 0048
 *  decision 3). No-op on an empty query or one already saved (idempotent, so a
 *  double-save can't create a duplicate). Returns the row id, or null. */
export function saveQuery(query: string, name?: string): string | null {
  const q = normalizeQuery(query);
  if (!q) return null;
  const existing = findSavedQuery(liveRows(), q);
  if (existing) return existing.id;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `sq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const trimmedName = name?.trim();
  const nameVal =
    trimmedName && trimmedName.length > 0 ? trimmedName : defaultQueryName(q);
  const createdAt = Date.now();
  const row: SavedQueryRow = {
    id,
    name: nameVal,
    query: q,
    createdAt,
  };
  if (lunoraWrites) {
    lunoraWrites.upsert(row);
    return id;
  }
  savedQueriesCollection.insert(row);
  return id;
}

/** Remove every saved row matching this (trimmed) query -- the pin's unsave. */
export function unsaveQuery(query: string): void {
  const q = normalizeQuery(query);
  if (!q) return;
  for (const row of liveRows()) {
    if (normalizeQuery(row.query) !== q) continue;
    if (lunoraWrites) {
      lunoraWrites.remove(row.id);
      continue;
    }
    savedQueriesCollection.delete(row.id);
  }
}

/** Pin toggle: save if this query isn't saved, else unsave it. */
export function toggleSavedQuery(query: string): void {
  if (isQuerySaved(liveRows(), query)) unsaveQuery(query);
  else saveQuery(query);
}

/** Rename a saved query. Ignores a blank name (a saved query is never nameless;
 *  the default is the query text). */
export function renameSavedQuery(id: string, name: string): void {
  const n = name.trim();
  if (!n) return;
  if (!liveRows().some((r) => r.id === id)) return;
  if (lunoraWrites) {
    lunoraWrites.patchName(id, n);
    return;
  }
  savedQueriesCollection.update(id, (draft) => void (draft.name = n));
}

/** Delete a saved query by id (the popover row's X). */
export function deleteSavedQuery(id: string): void {
  if (!liveRows().some((r) => r.id === id)) return;
  if (lunoraWrites) {
    lunoraWrites.remove(id);
    return;
  }
  savedQueriesCollection.delete(id);
}

// --- Reactive read (mirrors tag-colors.ts; prerender-safe) ------------------

const EMPTY: SavedQueryRow[] = [];
let rows: SavedQueryRow[] = EMPTY;
// A cached newest-first snapshot: useSyncExternalStore needs a STABLE reference
// between changes (re-sorting per getSnapshot call would loop), so sort once on
// rebuild and hand out this array until the next collection change.
let sorted: SavedQueryRow[] = EMPTY;
const listeners = new Set<() => void>();
let started = false;
let lunoraUnsub: (() => void) | null = null;

function rebuildFrom(source: SavedQueryRow[]) {
  rows = source;
  sorted = rows.length === 0 ? EMPTY : sortSavedNewestFirst(rows);
  for (const l of listeners) l();
}

function rebuild() {
  rebuildFrom(savedQueriesCollection.toArray);
}

/**
 * Called from `lunora-sync` when flag ON — subscribe to the Lunora shape and
 * skip `/api/kv` for this collection.
 */
export function bindLunoraSavedQueries(
  collection: {
    toArray: Array<{
      _id: string;
      name?: unknown;
      query?: unknown;
      createdAt?: unknown;
    }>;
    subscribeChanges: (
      cb: () => void,
      opts?: { includeInitialState?: boolean },
    ) => { unsubscribe: () => void };
  },
  writes: Omit<LunoraSavedQueryWrites, "list">,
): void {
  lunoraUnsub?.();
  const mapRows = (): SavedQueryRow[] =>
    collection.toArray.map((r) => ({
      id: r._id,
      name: String(r.name ?? ""),
      query: String(r.query ?? ""),
      createdAt: Number(r.createdAt ?? 0),
    }));
  lunoraWrites = {
    list: mapRows,
    ...writes,
  };
  const sub = collection.subscribeChanges(() => rebuildFrom(mapRows()), {
    includeInitialState: true,
  });
  lunoraUnsub = () => sub.unsubscribe();
  started = true;
}

/** Tear down Lunora feed (flag OFF / account switch). */
export function unbindLunoraSavedQueries(): void {
  lunoraUnsub?.();
  lunoraUnsub = null;
  lunoraWrites = null;
  rows = EMPTY;
  sorted = EMPTY;
  started = false;
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  if (isLunoraSyncEnabled()) return;
  started = true;
  savedQueriesCollection.subscribeChanges(() => rebuild(), {
    includeInitialState: true,
  });
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getRows(): SavedQueryRow[] {
  ensureStarted();
  return rows;
}

function getSorted(): SavedQueryRow[] {
  ensureStarted();
  return sorted;
}

/** All saved queries, newest-first, reactive. Drives the popover Saved section
 *  and the Cmd+K "Saved filters" group. */
export function useSavedQueries(): SavedQueryRow[] {
  return useSyncExternalStore(subscribe, getSorted, () => EMPTY);
}

/** Whether the current (trimmed) query is already saved -- the pin's pressed
 *  state, reactive. */
export function useIsQuerySaved(query: string): boolean {
  const getSnapshot = useCallback(
    () => isQuerySaved(getRows(), query),
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
