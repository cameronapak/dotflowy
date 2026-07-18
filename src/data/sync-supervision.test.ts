import { describe, expect, test } from "bun:test";
import { Cause, Duration } from "effect";

import {
  decideSyncRecovery,
  nextStreak,
  SYNC_RECOVERY_BUDGET,
  SYNC_STREAK_RESET_AFTER,
} from "./sync-supervision";

// The supervision policy for the inbound-sync consumer fiber (#234). Pins the
// two things easy to get wrong: an intentional interrupt must NEVER be treated
// as a fault (no recovery, no toast), and the retry budget must be bounded so a
// deterministically-poisonous frame can't hot-loop snapshot fetches.

describe("decideSyncRecovery", () => {
  test("an interrupt-only cause STOPS (never recovers, never toasts)", () => {
    // Cleanup / account switch tears the fiber down by interrupting it; that is
    // teardown, not a fault. Even at a zero recovery count it must map to Stop,
    // so the give-up toast can't fire on an intentional shutdown.
    expect(decideSyncRecovery(Cause.interrupt(1), 0)).toEqual({ _tag: "Stop" });
    // And it stays Stop regardless of how much budget is nominally left.
    expect(
      decideSyncRecovery(Cause.interrupt(1), SYNC_RECOVERY_BUDGET),
    ).toEqual({ _tag: "Stop" });
  });

  test("a defect RE-ESTABLISHES while budget remains", () => {
    const cause = Cause.die(new Error("applyMessage threw"));
    for (let used = 0; used < SYNC_RECOVERY_BUDGET; used++) {
      const decision = decideSyncRecovery(cause, used);
      expect(decision._tag).toBe("Reestablish");
    }
  });

  test("re-establish backs off exponentially, capped at 5s", () => {
    const cause = Cause.die(new Error("boom"));
    const delayMs = (used: number) => {
      const d = decideSyncRecovery(cause, used, 100);
      if (d._tag !== "Reestablish") throw new Error("expected Reestablish");
      return Duration.toMillis(d.delay);
    };
    expect(delayMs(0)).toBe(500);
    expect(delayMs(1)).toBe(1000);
    expect(delayMs(2)).toBe(2000);
    expect(delayMs(3)).toBe(4000);
    // 500 * 2^4 = 8000 -> capped to 5000; every higher attempt stays capped.
    expect(delayMs(4)).toBe(5000);
    expect(delayMs(10)).toBe(5000);
  });

  test("a defect GIVES UP once the budget is spent", () => {
    const cause = Cause.die(new Error("poison frame"));
    expect(decideSyncRecovery(cause, SYNC_RECOVERY_BUDGET)).toEqual({
      _tag: "GiveUp",
    });
    expect(decideSyncRecovery(cause, SYNC_RECOVERY_BUDGET + 5)).toEqual({
      _tag: "GiveUp",
    });
  });

  test("a typed failure cause is a fault too (recovers, then gives up)", () => {
    // The consumer's error channel is `never`, but guard the classification
    // anyway: a Fail is a fault, not an interrupt, so it recovers within budget
    // and gives up after — same as a defect.
    const cause = Cause.fail("some error" as never);
    expect(decideSyncRecovery(cause, 0)._tag).toBe("Reestablish");
    expect(decideSyncRecovery(cause, SYNC_RECOVERY_BUDGET)._tag).toBe("GiveUp");
  });

  test("budget is configurable", () => {
    const cause = Cause.die(new Error("x"));
    expect(decideSyncRecovery(cause, 0, 0)._tag).toBe("GiveUp");
    expect(decideSyncRecovery(cause, 0, 1)._tag).toBe("Reestablish");
    expect(decideSyncRecovery(cause, 1, 1)._tag).toBe("GiveUp");
  });
});

// The streak reset (the impure wiring in collection.ts records `lastFailureAt`
// and calls this with `Date.now()`). Without it the budget is a LIFETIME count:
// a tab open for days would flip the give-up toast on its 4th ever transient
// glitch even though every recovery held.

describe("nextStreak", () => {
  const RESET = Duration.toMillis(SYNC_STREAK_RESET_AFTER);

  test("first failure (no prior) keeps the count as-is", () => {
    expect(nextStreak(null, 1_000_000, 0)).toBe(0);
  });

  test("a failure within the window CONTINUES the streak", () => {
    const t0 = 1_000_000;
    expect(nextStreak(t0, t0 + 1, 2)).toBe(2);
    expect(nextStreak(t0, t0 + RESET, 2)).toBe(2); // boundary: exactly the window
  });

  test("a failure after the window RESETS the streak to 0", () => {
    const t0 = 1_000_000;
    expect(nextStreak(t0, t0 + RESET + 1, 2)).toBe(0);
    expect(nextStreak(t0, t0 + 10 * RESET, SYNC_RECOVERY_BUDGET)).toBe(0);
  });

  test("separated glitches never exhaust the budget (the day-old-tab scenario)", () => {
    // 10 transient glitches, each a stable stretch apart: every one is decided
    // at streak 0 -> Reestablish, never GiveUp.
    const cause = Cause.die(new Error("transient"));
    let last: number | null = null;
    let used = 0;
    let now = 0;
    for (let i = 0; i < 10; i++) {
      now += RESET + 5_000; // well past the window each time
      const streak = nextStreak(last, now, used);
      last = now;
      expect(decideSyncRecovery(cause, streak)._tag).toBe("Reestablish");
      used = streak + 1;
    }
  });

  test("rapid-fire failures still exhaust the budget (poison frame)", () => {
    const cause = Cause.die(new Error("poison"));
    let last: number | null = null;
    let used = 0;
    let now = 1_000_000;
    const decisions: string[] = [];
    for (let i = 0; i <= SYNC_RECOVERY_BUDGET; i++) {
      now += 500; // immediate re-failure, inside the window
      const streak = nextStreak(last, now, used);
      last = now;
      decisions.push(decideSyncRecovery(cause, streak)._tag);
      used = streak + 1;
    }
    expect(decisions).toEqual([
      "Reestablish",
      "Reestablish",
      "Reestablish",
      "GiveUp",
    ]);
  });
});
