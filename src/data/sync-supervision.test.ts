import { describe, expect, test } from "bun:test";
import { Cause, Duration } from "effect";

import { decideSyncRecovery, nextStreak } from "./sync-supervision";

// The supervision policy for the inbound-sync consumer fiber (#234). Pins the
// two things easy to get wrong: an intentional interrupt must NEVER be treated
// as a fault (no recovery, no toast), and the retry budget must be bounded so a
// deterministically-poisonous frame can't hot-loop snapshot fetches.

const RESET_MS = 60_000;

describe("decideSyncRecovery", () => {
  test("an interrupt-only cause STOPS (never recovers, never toasts)", () => {
    // Cleanup / account switch tears the fiber down by interrupting it; that is
    // teardown, not a fault, at any recovery count.
    expect(decideSyncRecovery(Cause.interrupt(1), 0)).toEqual({ _tag: "Stop" });
    expect(decideSyncRecovery(Cause.interrupt(1), 3)).toEqual({ _tag: "Stop" });
  });

  test.each([
    ["defect", Cause.die(new Error("applyMessage threw"))],
    // SAFETY: deliberate fault injection: only the Cause.fail shape matters to the classifier.
    ["typed failure", Cause.fail("some error" as never)],
  ])(
    "a %s re-establishes with doubling backoff, then gives up after three",
    (_name, cause) => {
      const delays = [0, 1, 2].map((used) => {
        const d = decideSyncRecovery(cause, used);
        if (d._tag !== "Reestablish") throw new Error("expected Reestablish");
        return Duration.toMillis(d.delay);
      });
      expect(delays).toEqual([500, 1000, 2000]);
      expect(decideSyncRecovery(cause, 3)).toEqual({ _tag: "GiveUp" });
      expect(decideSyncRecovery(cause, 8)).toEqual({ _tag: "GiveUp" });
    },
  );
});

// The streak reset (the impure wiring in collection.ts records `lastFailureAt`
// and calls this with `Date.now()`). Without it the budget is a LIFETIME count:
// a tab open for days would flip the give-up toast on its 4th ever transient
// glitch even though every recovery held.

describe("nextStreak", () => {
  test("the streak continues through exactly 60s and resets after", () => {
    const t0 = 1_000_000;
    expect(nextStreak(t0, t0 + RESET_MS, 2)).toBe(2);
    expect(nextStreak(t0, t0 + RESET_MS + 1, 2)).toBe(0);
  });

  test("separated glitches never exhaust the budget (the day-old-tab scenario)", () => {
    // 10 transient glitches, each a stable stretch apart: every one is decided
    // at streak 0 -> Reestablish, never GiveUp.
    const cause = Cause.die(new Error("transient"));
    let last: number | null = null;
    let used = 0;
    let now = 0;
    for (let i = 0; i < 10; i++) {
      now += RESET_MS + 5_000; // well past the window each time
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
    for (let i = 0; i < 4; i++) {
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
