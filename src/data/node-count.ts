/**
 * Live total node count — the number the free-tier ceiling (#170) is measured
 * against, read reactively for the Settings page's usage meter.
 *
 * Modelled on `changelog-cursor.ts`: `subscribeChanges` + `useSyncExternalStore`,
 * NEVER `useLiveQuery` (which hard-fails the `/` prerender, and Settings shares
 * the same bundle). Subscribing here also STARTS the collection's sync if nothing
 * else has yet — a direct visit to `/settings` (no OutlineEditor mounted) still
 * gets a real count once the snapshot lands.
 *
 * `toArray.length` is the same basis the DO caps on (every live row, including
 * the daily scaffold), so the meter and the wall agree.
 */

import { useSyncExternalStore } from "react";

import { nodesCollection } from "./collection";

export interface NodeCountSnapshot {
  /** Total live nodes, or `0` until the first snapshot lands. */
  count: number;
  /** False until the collection has loaded at least once — the meter shows a
   *  muted placeholder while false so we never flash "0 of 10,000". */
  ready: boolean;
}

const HIDDEN: NodeCountSnapshot = { count: 0, ready: false };

let snapshot: NodeCountSnapshot = HIDDEN;
let ready = false;
let started = false;
const listeners = new Set<() => void>();

function rebuild() {
  const count = ready ? nodesCollection.toArray.length : 0;
  // Referential stability: useSyncExternalStore re-renders on identity change.
  if (snapshot.ready === ready && snapshot.count === count) return;
  snapshot = { ready, count };
  for (const l of listeners) l();
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  // subscribeChanges starts the collection syncing if it hasn't already.
  nodesCollection.subscribeChanges(() => rebuild(), {
    includeInitialState: true,
  });
  void nodesCollection
    .toArrayWhenReady()
    .then(() => {
      ready = true;
      rebuild();
    })
    // A snapshot that never lands leaves the meter in its muted placeholder.
    .catch(() => {});
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): NodeCountSnapshot {
  ensureStarted();
  return snapshot;
}

/** The live node count + readiness, for the Settings usage meter. */
export function useNodeCount(): NodeCountSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => HIDDEN);
}
