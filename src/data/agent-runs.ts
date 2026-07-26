/**
 * Client view of Lunora `runs` (ADR 0059). Ghost text + chip state subscribe
 * here. Bound from lunora-sync when upgraded sync is ON; cold otherwise.
 */

import { useCallback, useSyncExternalStore } from "react";

export type AgentRunStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "error"
  | null;

export type AgentRunRow = {
  runId: string;
  questionNodeId: string;
  status: Exclude<AgentRunStatus, null>;
  partialText: string;
  answerRootId: string | null;
  answerHash: string | null;
  error: string | null;
  updatedAt: number;
};

type LunoraRunDoc = {
  _id: string;
  questionNodeId?: unknown;
  status?: unknown;
  partialText?: unknown;
  answerRootId?: unknown;
  answerHash?: unknown;
  error?: unknown;
  updatedAt?: unknown;
};

const EMPTY: AgentRunRow[] = [];
const listeners = new Set<() => void>();
let rows: AgentRunRow[] = EMPTY;
let lunoraUnsub: (() => void) | null = null;

function emit() {
  for (const l of listeners) l();
}

function rebuildFrom(docs: LunoraRunDoc[]) {
  const next: AgentRunRow[] = docs.map((r) => ({
    runId: r._id,
    questionNodeId: String(r.questionNodeId ?? ""),
    status: (r.status as AgentRunRow["status"]) ?? "error",
    partialText: String(r.partialText ?? ""),
    answerRootId: typeof r.answerRootId === "string" ? r.answerRootId : null,
    answerHash: typeof r.answerHash === "string" ? r.answerHash : null,
    error: typeof r.error === "string" ? r.error : null,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  }));
  rows = next;
  emit();
}

/** Bind Lunora `userAgentRuns` collection (flag ON). */
export function bindLunoraAgentRuns(collection: {
  toArray: LunoraRunDoc[];
  subscribeChanges: (
    cb: () => void,
    opts?: { includeInitialState?: boolean },
  ) => { unsubscribe: () => void };
}): void {
  lunoraUnsub?.();
  const sub = collection.subscribeChanges(
    () => rebuildFrom(collection.toArray as LunoraRunDoc[]),
    { includeInitialState: true },
  );
  lunoraUnsub = () => sub.unsubscribe();
}

export function unbindLunoraAgentRuns(): void {
  lunoraUnsub?.();
  lunoraUnsub = null;
  rows = EMPTY;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getRows(): AgentRunRow[] {
  return rows;
}

/** Newest run for a question node (running preferred). */
export function getAgentRunForQuestion(
  questionNodeId: string,
): AgentRunRow | null {
  let best: AgentRunRow | null = null;
  for (const row of rows) {
    if (row.questionNodeId !== questionNodeId) continue;
    if (!best) {
      best = row;
      continue;
    }
    if (row.status === "running" && best.status !== "running") best = row;
    else if (row.status === best.status && row.updatedAt > best.updatedAt) {
      best = row;
    }
  }
  return best;
}

/** Ghost text while a run is streaming on this question. */
export function useAgentGhostText(questionNodeId: string): string | null {
  const getSnapshot = useCallback(() => {
    const run = getAgentRunForQuestion(questionNodeId);
    if (!run || run.status !== "running") return null;
    return run.partialText || null;
  }, [questionNodeId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** Reactive run status for chip chrome. */
export function useAgentRunStatus(questionNodeId: string): AgentRunStatus {
  const getSnapshot = useCallback(() => {
    return getAgentRunForQuestion(questionNodeId)?.status ?? null;
  }, [questionNodeId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function useAgentRunRows(): AgentRunRow[] {
  return useSyncExternalStore(subscribe, getRows, () => EMPTY);
}
