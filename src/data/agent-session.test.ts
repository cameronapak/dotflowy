import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  AskRowSchema,
  PresenceRowSchema,
  activeAskForNode,
  freshestLivePresence,
  hasLivePresence,
  isAskActive,
  isAskTransitionError,
  planAnnouncePresence,
  planCancelAsk,
  planClaimAsk,
  planCompleteAsk,
  planCreateAsk,
  filterAsks,
  PRESENCE_STALE_MS,
} from "./agent-session";

describe("agent-session planners (ADR 0059)", () => {
  test("presence + ask schemas round-trip", () => {
    const presence = planAnnouncePresence({
      agentId: "ag-1",
      label: "  Cursor  ",
      now: 1000,
    });
    expect(presence.label).toBe("Cursor");
    expect(Schema.decodeUnknownSync(PresenceRowSchema)(presence)).toEqual(
      presence,
    );

    const ask = planCreateAsk({
      id: "ask-1",
      questionNodeId: "node-a",
      now: 2000,
    });
    expect(ask.status).toBe("pending");
    expect(Schema.decodeUnknownSync(AskRowSchema)(ask)).toEqual(ask);
  });

  test("freshestLivePresence picks newest fresh row", () => {
    const stale = planAnnouncePresence({
      agentId: "old",
      label: "Old",
      now: 0,
    });
    const a = planAnnouncePresence({
      agentId: "a",
      label: "A",
      now: 50_000,
    });
    const b = planAnnouncePresence({
      agentId: "b",
      label: "B",
      now: 80_000,
    });
    const now = 100_000;
    expect(hasLivePresence([stale, a, b], now)).toBe(true);
    expect(freshestLivePresence([stale, a, b], now)?.label).toBe("B");
    expect(freshestLivePresence([stale], now)).toBeNull();
    expect(PRESENCE_STALE_MS).toBe(90_000);
  });

  test("claim and complete transitions", () => {
    const ask = planCreateAsk({
      id: "ask-1",
      questionNodeId: "n",
      now: 1,
    });
    const claimed = planClaimAsk(ask, "ag", 2);
    expect(isAskTransitionError(claimed)).toBe(false);
    if (isAskTransitionError(claimed)) return;
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimedBy).toBe("ag");

    const conflict = planClaimAsk(claimed, "other", 3);
    expect(isAskTransitionError(conflict)).toBe(true);

    const done = planCompleteAsk(claimed, "ag", 4);
    expect(isAskTransitionError(done)).toBe(false);
    if (isAskTransitionError(done)) return;
    expect(done.status).toBe("done");
    expect(done.doneAt).toBe(4);
  });

  test("filterAsks defaults ordering and status filter", () => {
    const a = planCreateAsk({ id: "b", questionNodeId: "n", now: 20 });
    const b = planCreateAsk({ id: "a", questionNodeId: "n", now: 10 });
    expect(filterAsks([a, b], "pending").map((r) => r.id)).toEqual(["a", "b"]);
    const claimed = planClaimAsk(a, "ag", 30);
    if (isAskTransitionError(claimed)) throw new Error("unexpected");
    expect(filterAsks([claimed, b], "pending")).toHaveLength(1);
    expect(filterAsks([claimed, b], null)).toHaveLength(2);
  });

  test("hasLivePresence respects stale window", () => {
    const row = planAnnouncePresence({
      agentId: "ag",
      label: "X",
      now: 1000,
    });
    expect(hasLivePresence([row], 1000 + PRESENCE_STALE_MS - 1)).toBe(true);
    expect(hasLivePresence([row], 1000 + PRESENCE_STALE_MS)).toBe(false);
  });

  test("planCancelAsk + activeAskForNode", () => {
    const ask = planCreateAsk({
      id: "ask-1",
      questionNodeId: "n",
      now: 1,
    });
    expect(isAskActive(ask.status)).toBe(true);
    expect(activeAskForNode([ask], "n")?.id).toBe("ask-1");
    expect(activeAskForNode([ask], "other")).toBeNull();

    const cancelled = planCancelAsk(ask, 2);
    expect(isAskTransitionError(cancelled)).toBe(false);
    if (isAskTransitionError(cancelled)) return;
    expect(cancelled.status).toBe("cancelled");
    expect(isAskActive(cancelled.status)).toBe(false);
    expect(activeAskForNode([cancelled], "n")).toBeNull();

    const done = planCompleteAsk(ask, "ag", 3);
    if (isAskTransitionError(done)) throw new Error("unexpected");
    const cancelDone = planCancelAsk(done, 4);
    expect(isAskTransitionError(cancelDone)).toBe(true);
  });
});
