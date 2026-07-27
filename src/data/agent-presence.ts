/**
 * Agent presence side-collection (ADR 0059 step 2).
 *
 * SPA is read-only here — agents write via MCP `announce_presence`. Mirrors
 * `saved-queries.ts` / `tag-colors.ts`: kv query collection +
 * `subscribeChanges` / `useSyncExternalStore` (NOT `useLiveQuery`, prerender-safe).
 *
 * Polling: call {@link refetchAgentPresence} on an interval while the Add agent
 * modal waits or the header chip is mounted — kv has no realtime push.
 */

import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

import {
  KV_AGENT_PRESENCE,
  PresenceRowSchema,
  freshestLivePresence,
  hasLivePresence,
  type PresenceRow,
} from "./agent-session";
import { kvFetch } from "./kv-api";
import { queryClient } from "./query-client";

export type { PresenceRow };

export const agentPresenceCollection = createCollection(
  queryCollectionOptions({
    id: "agent-presence",
    queryKey: ["kv", KV_AGENT_PRESENCE],
    queryClient,
    queryFn: () => kvFetch<PresenceRow>(KV_AGENT_PRESENCE),
    getKey: (row: PresenceRow) => row.key,
    schema: Schema.toStandardSchemaV1(PresenceRowSchema),
  }),
);

const EMPTY: PresenceRow[] = [];
let rows: PresenceRow[] = EMPTY;
const listeners = new Set<() => void>();
let started = false;

function rebuild() {
  rows = agentPresenceCollection.toArray;
  for (const l of listeners) l();
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  // Classic DO kv only for v1 (Lunora agent-presence tables deferred — HANDOFF).
  // Still poll /api/kv while Lunora sync is on: MCP BYOA is classic-path today.
  started = true;
  agentPresenceCollection.subscribeChanges(() => rebuild(), {
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

function getRows(): PresenceRow[] {
  ensureStarted();
  return rows;
}

/** Invalidate the presence query so the next poll picks up MCP heartbeats. */
export function refetchAgentPresence(): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: ["kv", KV_AGENT_PRESENCE],
  });
}

/** All presence rows (may include stale). Reactive, prerender-safe. */
export function useAgentPresenceRows(): PresenceRow[] {
  return useSyncExternalStore(subscribe, getRows, () => EMPTY);
}

/** Sync read for event-time play gate (starts the subscription if needed). */
export function getAgentPresenceRows(): PresenceRow[] {
  return getRows();
}

export type LivePresenceSnapshot = {
  live: boolean;
  agent: PresenceRow | null;
};

/** Live presence derived at `now` (caller ticks `now` so staleness updates). */
export function livePresenceAt(
  rows: readonly PresenceRow[],
  now: number,
): LivePresenceSnapshot {
  return {
    live: hasLivePresence(rows, now),
    agent: freshestLivePresence(rows, now),
  };
}
