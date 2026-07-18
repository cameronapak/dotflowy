import { describe, expect, test } from "bun:test";
import { Cause, Duration } from "effect";

import { decideSyncRecovery, SYNC_RECOVERY_BUDGET } from "./sync-supervision";

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
