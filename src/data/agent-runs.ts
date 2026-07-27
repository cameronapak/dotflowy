/**
 * Client view of Lunora `runs` (ADR 0059). Ghost text + chip state subscribe
 * here. Bound from lunora-sync when upgraded sync is ON; cold otherwise.
 *
 * Server-side `fireAgentRun` writes runs via action→runMutation (no client
 * optimistic apply). Live shape poke needs a healthy `/_lunora/ws`. When WS
 * is dead, `noteLocalAgentRun` paints the ghost immediately and
 * `softReloadLunoraOutline` after the action catches up nodes.
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
/** Fire-time overlay when shape sync hasn't delivered a `running` row yet. */
let localOverlay: AgentRunRow | null = null;
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
  // #region agent log
  const running = next.filter((r) => r.status === "running");
  fetch("http://127.0.0.1:7920/ingest/4fe7f996-e307-4b62-b12b-1c7d5e6b57b8", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "a23e41",
    },
    body: JSON.stringify({
      sessionId: "a23e41",
      hypothesisId: "H1",
      location: "src/data/agent-runs.ts:rebuildFrom",
      message: "agent-runs collection patched",
      data: {
        rowCount: next.length,
        runningCount: running.length,
        partialLens: running.map((r) => r.partialText.length),
        hasLocalOverlay: !!localOverlay,
      },
      timestamp: Date.now(),
      runId: "ui-sync",
    }),
  }).catch(() => {});
  // #endregion
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
  // #region agent log
  fetch("http://127.0.0.1:7920/ingest/4fe7f996-e307-4b62-b12b-1c7d5e6b57b8", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "a23e41",
    },
    body: JSON.stringify({
      sessionId: "a23e41",
      hypothesisId: "H1",
      location: "src/data/agent-runs.ts:bindLunoraAgentRuns",
      message: "bound agent-runs collection",
      data: { initialLen: (collection.toArray as LunoraRunDoc[]).length },
      timestamp: Date.now(),
      runId: "ui-sync",
    }),
  }).catch(() => {});
  // #endregion
}

export function unbindLunoraAgentRuns(): void {
  lunoraUnsub?.();
  lunoraUnsub = null;
  rows = EMPTY;
  localOverlay = null;
  emit();
}

/**
 * Paint a running ghost before Lunora shape sync delivers the server row.
 * Pass `null` to clear (after fire settles / soft-reload).
 */
export function noteLocalAgentRun(row: AgentRunRow | null): void {
  localOverlay = row;
  // #region agent log
  fetch("http://127.0.0.1:7920/ingest/4fe7f996-e307-4b62-b12b-1c7d5e6b57b8", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "a23e41",
    },
    body: JSON.stringify({
      sessionId: "a23e41",
      hypothesisId: "H3",
      location: "src/data/agent-runs.ts:noteLocalAgentRun",
      message: row ? "local running overlay set" : "local overlay cleared",
      data: {
        questionNodeId: row?.questionNodeId ?? null,
        status: row?.status ?? null,
      },
      timestamp: Date.now(),
      runId: "ui-sync",
    }),
  }).catch(() => {});
  // #endregion
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getRows(): AgentRunRow[] {
  if (!localOverlay) return rows;
  const q = localOverlay.questionNodeId;
  const rest = rows.filter((r) => r.questionNodeId !== q);
  return [localOverlay, ...rest];
}

/** Newest run for a question node (synced running preferred over local stub). */
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
  if (best?.status === "running") return best;
  if (
    localOverlay &&
    localOverlay.questionNodeId === questionNodeId &&
    localOverlay.status === "running"
  ) {
    return localOverlay;
  }
  return best;
}

/** Ghost text while a run is streaming on this question. */
export function useAgentGhostText(questionNodeId: string): string | null {
  const getSnapshot = useCallback(() => {
    const run = getAgentRunForQuestion(questionNodeId);
    if (!run || run.status !== "running") return null;
    // Ellipsis before the first token so ▶ Run isn't silent (ADR 0059 ghost).
    return run.partialText || "…";
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
