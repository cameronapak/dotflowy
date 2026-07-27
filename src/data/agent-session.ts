/**
 * Bring-your-own-agent session domain (ADR 0059): presence + asks.
 *
 * Stored as DO kv side-collections (classic path; Lunora tables deferred).
 * Not a second mutation path — outline writes stay applyBatch / existing MCP
 * tools. This leaf is DOM-free so Worker + client + bun test share one shape.
 */

import { Schema } from "effect";

/** Classic DO kv collections (also listed in Worker KV_COLLECTIONS for SPA reads). */
export const KV_AGENT_PRESENCE = "agent-presence";
export const KV_AGENT_ASKS = "agent-asks";

/**
 * Without a heartbeat newer than this, presence is stale ("Waiting…" stays).
 * Join prompt asks agents to announce ~every 20–30s.
 */
export const PRESENCE_STALE_MS = 90_000;

export const AskStatusSchema = Schema.Literals([
  "pending",
  "claimed",
  "done",
  "cancelled",
]);
export type AskStatus = Schema.Schema.Type<typeof AskStatusSchema>;

export const PresenceRowSchema = Schema.Struct({
  /** = agentId (kv key). */
  key: Schema.String,
  agentId: Schema.String,
  label: Schema.String,
  lastSeenAt: Schema.Number,
});
export type PresenceRow = Schema.Schema.Type<typeof PresenceRowSchema>;

export const AskRowSchema = Schema.Struct({
  /** = id (kv key). */
  key: Schema.String,
  id: Schema.String,
  questionNodeId: Schema.String,
  status: AskStatusSchema,
  createdAt: Schema.Number,
  claimedAt: Schema.NullOr(Schema.Number),
  claimedBy: Schema.NullOr(Schema.String),
  doneAt: Schema.NullOr(Schema.Number),
});
export type AskRow = Schema.Schema.Type<typeof AskRowSchema>;

export function isPresenceFresh(
  row: PresenceRow,
  now: number,
  staleMs = PRESENCE_STALE_MS,
): boolean {
  return now - row.lastSeenAt < staleMs;
}

/** True when any presence row is still fresh. */
export function hasLivePresence(
  rows: readonly PresenceRow[],
  now: number,
  staleMs = PRESENCE_STALE_MS,
): boolean {
  return rows.some((r) => isPresenceFresh(r, now, staleMs));
}

/** Freshest live presence row (for the header chip label), or null. */
export function freshestLivePresence(
  rows: readonly PresenceRow[],
  now: number,
  staleMs = PRESENCE_STALE_MS,
): PresenceRow | null {
  let best: PresenceRow | null = null;
  for (const r of rows) {
    if (!isPresenceFresh(r, now, staleMs)) continue;
    if (!best || r.lastSeenAt > best.lastSeenAt) best = r;
  }
  return best;
}

export function planAnnouncePresence(args: {
  agentId: string;
  label: string;
  now: number;
}): PresenceRow {
  const label = args.label.trim() || "Agent";
  return {
    key: args.agentId,
    agentId: args.agentId,
    label,
    lastSeenAt: args.now,
  };
}

export function planCreateAsk(args: {
  id: string;
  questionNodeId: string;
  now: number;
}): AskRow {
  return {
    key: args.id,
    id: args.id,
    questionNodeId: args.questionNodeId,
    status: "pending",
    createdAt: args.now,
    claimedAt: null,
    claimedBy: null,
    doneAt: null,
  };
}

export type AskTransitionError = {
  readonly _tag: "AskTransitionError";
  readonly reason: string;
};

export function isAskTransitionError(
  value: AskRow | AskTransitionError,
): value is AskTransitionError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "AskTransitionError"
  );
}

function askError(reason: string): AskTransitionError {
  return { _tag: "AskTransitionError", reason };
}

/** Claim a pending ask for `agentId`. */
export function planClaimAsk(
  ask: AskRow,
  agentId: string,
  now: number,
): AskRow | AskTransitionError {
  switch (ask.status) {
    case "pending":
      return {
        ...ask,
        status: "claimed",
        claimedAt: now,
        claimedBy: agentId,
      };
    case "claimed":
      if (ask.claimedBy === agentId) return ask;
      return askError(
        `ask ${ask.id} is already claimed by ${ask.claimedBy ?? "another agent"}`,
      );
    case "done":
      return askError(`ask ${ask.id} is already done`);
    case "cancelled":
      return askError(`ask ${ask.id} was cancelled`);
    default: {
      const _exhaustive: never = ask.status;
      return askError(`unknown ask status: ${String(_exhaustive)}`);
    }
  }
}

/** Mark a claimed (or self-owned) ask done. */
export function planCompleteAsk(
  ask: AskRow,
  agentId: string | null,
  now: number,
): AskRow | AskTransitionError {
  switch (ask.status) {
    case "pending":
      // Allow complete without claim for short loops / tests.
      return {
        ...ask,
        status: "done",
        claimedAt: ask.claimedAt ?? now,
        claimedBy: ask.claimedBy ?? agentId,
        doneAt: now,
      };
    case "claimed":
      if (
        agentId !== null &&
        ask.claimedBy !== null &&
        ask.claimedBy !== agentId
      ) {
        return askError(
          `ask ${ask.id} is claimed by ${ask.claimedBy}, not ${agentId}`,
        );
      }
      return { ...ask, status: "done", doneAt: now };
    case "done":
      return ask;
    case "cancelled":
      return askError(`ask ${ask.id} was cancelled`);
    default: {
      const _exhaustive: never = ask.status;
      return askError(`unknown ask status: ${String(_exhaustive)}`);
    }
  }
}

/** User cancel from the row Stop control (pending or claimed → cancelled). */
export function planCancelAsk(
  ask: AskRow,
  _now: number,
): AskRow | AskTransitionError {
  switch (ask.status) {
    case "pending":
    case "claimed":
      return {
        ...ask,
        status: "cancelled",
      };
    case "done":
      return askError(`ask ${ask.id} is already done`);
    case "cancelled":
      return ask;
    default: {
      const _exhaustive: never = ask.status;
      return askError(`unknown ask status: ${String(_exhaustive)}`);
    }
  }
}

/** Row is busy while an ask for that node is pending or claimed. */
export function isAskActive(status: AskStatus): boolean {
  switch (status) {
    case "pending":
    case "claimed":
      return true;
    case "done":
    case "cancelled":
      return false;
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return false;
    }
  }
}

/** Newest active ask for a question node, or null. */
export function activeAskForNode(
  rows: readonly AskRow[],
  questionNodeId: string,
): AskRow | null {
  let best: AskRow | null = null;
  for (const r of rows) {
    if (r.questionNodeId !== questionNodeId) continue;
    if (!isAskActive(r.status)) continue;
    if (!best || r.createdAt > best.createdAt) best = r;
  }
  return best;
}

export function filterAsks(
  rows: readonly AskRow[],
  status: AskStatus | null,
): AskRow[] {
  const filtered =
    status === null ? [...rows] : rows.filter((r) => r.status === status);
  return filtered.sort((a, b) => a.createdAt - b.createdAt);
}

export function formatAskLine(ask: AskRow): string {
  const claim = ask.claimedBy !== null ? ` claimedBy=${ask.claimedBy}` : "";
  return `- ask ${ask.id}: node=${ask.questionNodeId} status=${ask.status}${claim} createdAt=${ask.createdAt}`;
}

export function formatPresenceLine(row: PresenceRow): string {
  return `- ${row.label} (agentId: ${row.agentId}) lastSeenAt=${row.lastSeenAt}`;
}
