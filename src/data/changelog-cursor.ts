/**
 * "Have I read this?" — one row, synced (ADR 0046).
 *
 * The cursor is a VERSION, not a `seq`: `releases[0].version !== lastSeenVersion`
 * answers "is there news", and a `findIndex` answers "how many did I miss". No
 * integer compare, no semver parser in the client bundle.
 *
 * It lives in a `/api/kv` side-collection (ADR 0008) rather than localStorage,
 * because "I've read the changelog" is ACCOUNT state, not device state — reading
 * it on your laptop should clear the badge on your phone. Modelled on
 * `tag-colors.ts` down to the reactive-read shape, and passing its CONCRETE
 * Effect Schema inline (ADR 0008 forbids a generic kv-collection factory).
 *
 * The badge is the whole reason this file is careful:
 *
 * | state             | badge                                          |
 * | ----------------- | ---------------------------------------------- |
 * | not ready         | hidden                                         |
 * | ready, no row     | hidden -- seed `lastSeen = latest` silently    |
 * | ready, = latest   | hidden                                         |
 * | ready, < latest   | shown                                          |
 *
 * `null` means BOTH "not loaded" and "no row", which is why readiness is tracked
 * separately (`toArrayWhenReady`, not a row-change subscription -- a collection
 * that resolves to zero rows emits no changes and would never notify).
 *
 * **Seeding silently is load-bearing.** The first badge a user ever sees defines
 * what the badge means. Firing it for a release they already lived through
 * teaches them, on day one, that it isn't about change.
 */

import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

import { latestVersion, releases, unseenCount } from "./changelog-data";
import { kvFetch, kvPut, toKvRows } from "./kv-api";
import { queryClient } from "./query-client";

const cursorSchema = Schema.Struct({
  /** Always {@link ROW_ID} -- the collection holds exactly one row. */
  id: Schema.String,
  /** The newest release this account has seen. */
  lastSeenVersion: Schema.String,
});

export type ChangelogCursorRow = Schema.Schema.Type<typeof cursorSchema>;

const KV = "changelog";
const ROW_ID = "cursor";

export const changelogCursorCollection = createCollection(
  queryCollectionOptions({
    id: "changelog-cursor",
    queryKey: ["kv", KV],
    queryClient,
    queryFn: () => kvFetch<ChangelogCursorRow>(KV),
    getKey: (row: ChangelogCursorRow) => row.id,
    schema: Schema.toStandardSchemaV1(cursorSchema),
    onInsert: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
  }),
);

/** Write the cursor to the latest release. Insert-or-update, because the row may
 *  not exist yet; a failed write rolls back optimistically and the badge simply
 *  reappears next session. */
function writeCursor(version: string) {
  const exists = changelogCursorCollection.toArray.some((r) => r.id === ROW_ID);
  if (exists) {
    changelogCursorCollection.update(
      ROW_ID,
      (draft) => void (draft.lastSeenVersion = version),
    );
  } else {
    changelogCursorCollection.insert({ id: ROW_ID, lastSeenVersion: version });
  }
}

/** Mark every release as read. Called when the changelog dialog opens. */
export function markChangelogSeen(): void {
  if (!latestVersion) return;
  if (currentVersion() === latestVersion) return;
  writeCursor(latestVersion);
}

// --- Reactive read -----------------------------------------------------------
// subscribeChanges + useSyncExternalStore, never useLiveQuery -- it hard-fails
// the `/` prerender, and the badge lives in the header, which prerenders.
// Readiness rides `toArrayWhenReady()` because a collection that loads to zero
// rows emits no change and would leave a row-only subscription waiting forever.

const HIDDEN = { ready: false, version: null } as const;

type CursorSnapshot = { ready: boolean; version: string | null };

let snapshot: CursorSnapshot = HIDDEN;
let collectionReady = false;
const listeners = new Set<() => void>();
let started = false;
/** At most one silent seed per session, so a rejected kv write (offline) can't
 *  become a retry loop against the optimistic rollback. */
let seeded = false;

function currentVersion(): string | null {
  return (
    changelogCursorCollection.toArray.find((r) => r.id === ROW_ID)
      ?.lastSeenVersion ?? null
  );
}

function rebuild() {
  const version = collectionReady ? currentVersion() : null;
  // Referential stability: useSyncExternalStore re-renders on identity change.
  if (snapshot.ready === collectionReady && snapshot.version === version)
    return;
  snapshot = { ready: collectionReady, version };
  for (const l of listeners) l();

  // Ready with no row = a user who has never seen the badge. Adopt the current
  // release as already-read, and say nothing.
  if (collectionReady && version === null && latestVersion && !seeded) {
    seeded = true;
    writeCursor(latestVersion);
  }
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  changelogCursorCollection.subscribeChanges(() => rebuild(), {
    includeInitialState: true,
  });
  void changelogCursorCollection
    .toArrayWhenReady()
    .then(() => {
      collectionReady = true;
      rebuild();
    })
    // A kv fetch that never lands leaves the badge hidden. Fail closed: a badge
    // we can't justify is worse than no badge.
    .catch(() => {});
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): CursorSnapshot {
  ensureStarted();
  return snapshot;
}

/** How many releases this account hasn't seen. `0` whenever we can't justify a
 *  number — not loaded, no row, already current, or a cursor version this build
 *  has never heard of. */
export function useUnseenReleaseCount(): number {
  const { ready, version } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => HIDDEN,
  );
  if (!ready) return 0;
  return unseenCount(releases, version);
}

/** The releases the reader hasn't seen, newest first (empty when caught up). */
export function unseenReleases(count: number) {
  return releases.slice(0, count);
}
