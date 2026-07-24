/**
 * Live total node count — the number the free-tier ceiling (#170) is measured
 * against, read reactively for the Settings page's usage meter.
 *
 * Modelled on `changelog-cursor.ts`: `useSyncExternalStore` over the shared
 * tree index + sync-ready signal, NEVER `useLiveQuery` (which hard-fails the
 * `/` prerender, and Settings shares the same bundle).
 *
 * Count comes from `getTreeIndex().byId.size` so both sync backends agree:
 * classic DO feeds the tree via `nodesCollection`, Lunora (ADR 0055) via
 * `resetTreeFromNodes`. Reading classic `nodesCollection` alone shows 0 when
 * the Lunora flag is ON (that collection stays idle + empty).
 *
 * `byId.size` is the same basis the free-tier wall measures (every live row,
 * including the daily scaffold).
 */

import { useSyncExternalStore } from "react";

import { isSyncReady, subscribeSyncReady } from "./collection";
import { getTreeIndex, subscribeTree } from "./tree-store";

export interface NodeCountSnapshot {
  /** Total live nodes, or `0` until the first snapshot lands. */
  count: number;
  /** False until sync is ready — the meter shows a muted placeholder while
   *  false so we never flash "0 of 10,000" for a still-loading outline. */
  ready: boolean;
}

const HIDDEN: NodeCountSnapshot = { count: 0, ready: false };

let snapshot: NodeCountSnapshot = HIDDEN;
const listeners = new Set<() => void>();
let started = false;

function rebuild() {
  const ready = isSyncReady();
  const count = ready ? getTreeIndex().byId.size : 0;
  // Referential stability: useSyncExternalStore re-renders on identity change.
  if (snapshot.ready === ready && snapshot.count === count) return;
  snapshot = { ready, count };
  for (const l of listeners) l();
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  // Tree subscription starts classic collection sync when the Lunora flag is
  // OFF; when ON, LunoraSyncHost feeds the tree and marks sync ready.
  subscribeTree(() => rebuild());
  subscribeSyncReady(() => rebuild());
  rebuild();
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
