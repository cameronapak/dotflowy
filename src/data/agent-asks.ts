/**
 * Agent asks side-collection (ADR 0059 step 3).
 *
 * SPA creates pending asks on play; agents claim/complete via MCP. Mirrors
 * `agent-presence.ts` / `saved-queries.ts`: kv query collection +
 * `subscribeChanges` / `useSyncExternalStore` (NOT `useLiveQuery`).
 *
 * Classic DO kv only for v1 (Lunora agent-asks tables deferred — HANDOFF).
 */

import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

import {
  AskRowSchema,
  KV_AGENT_ASKS,
  activeAskForNode,
  isAskTransitionError,
  planCancelAsk,
  planCreateAsk,
  type AskRow,
} from "./agent-session";
import { kvFetch, kvPut, toKvRows } from "./kv-api";
import { queryClient } from "./query-client";

export type { AskRow };

export const agentAsksCollection = createCollection(
  queryCollectionOptions({
    id: "agent-asks",
    queryKey: ["kv", KV_AGENT_ASKS],
    queryClient,
    queryFn: () => kvFetch<AskRow>(KV_AGENT_ASKS),
    getKey: (row: AskRow) => row.key,
    schema: Schema.toStandardSchemaV1(AskRowSchema),
    onInsert: async ({ transaction }) => {
      await kvPut(KV_AGENT_ASKS, toKvRows(transaction));
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      await kvPut(KV_AGENT_ASKS, toKvRows(transaction));
      return { refetch: false };
    },
  }),
);

const EMPTY: AskRow[] = [];
let rows: AskRow[] = EMPTY;
const listeners = new Set<() => void>();
let started = false;

function rebuild() {
  rows = agentAsksCollection.toArray;
  for (const l of listeners) l();
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  agentAsksCollection.subscribeChanges(() => rebuild(), {
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

function getRows(): AskRow[] {
  ensureStarted();
  return rows;
}

function newAskId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Invalidate so the next poll picks up agent claim/complete. */
export function refetchAgentAsks(): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: ["kv", KV_AGENT_ASKS],
  });
}

/** All ask rows. Reactive, prerender-safe. */
export function useAgentAskRows(): AskRow[] {
  return useSyncExternalStore(subscribe, getRows, () => EMPTY);
}

/** Sync read for event-time play/stop (starts the subscription if needed). */
export function getAgentAskRows(): AskRow[] {
  return getRows();
}

/** Active (pending/claimed) ask for this question node, or null. */
export function useActiveAskForNode(questionNodeId: string): AskRow | null {
  const all = useAgentAskRows();
  if (!questionNodeId) return null;
  return activeAskForNode(all, questionNodeId);
}

/**
 * Create a pending ask for `questionNodeId` (SPA play path).
 * Returns the ask id, or null if one is already active for that node.
 */
export function createPendingAsk(questionNodeId: string): string | null {
  ensureStarted();
  if (activeAskForNode(agentAsksCollection.toArray, questionNodeId)) {
    return null;
  }
  const id = newAskId();
  const row = planCreateAsk({
    id,
    questionNodeId,
    now: Date.now(),
  });
  agentAsksCollection.insert(row);
  return id;
}

/**
 * Cancel the active ask for `questionNodeId` (row Stop). No-op if none /
 * already terminal. Returns true when a cancel write was applied.
 */
export function cancelActiveAsk(questionNodeId: string): boolean {
  ensureStarted();
  const ask = activeAskForNode(agentAsksCollection.toArray, questionNodeId);
  if (!ask) return false;
  const next = planCancelAsk(ask, Date.now());
  if (isAskTransitionError(next)) return false;
  agentAsksCollection.update(ask.key, (draft) => {
    draft.status = next.status;
  });
  return true;
}
