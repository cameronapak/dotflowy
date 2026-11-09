import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { waitForSeqE, waitForSeqStrictE } from "./collection";

// A committed structural write must stay pending without observed sync.
// Calendar activation separately rejects a missing echo.

describe("echo waiters", () => {
  test("waitForSeqE retains acknowledged writes across repeated echo deadlines", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let settled = false;
        yield* waitForSeqE(Number.MAX_SAFE_INTEGER).pipe(
          Effect.onExit(() =>
            Effect.sync(() => {
              settled = true;
            }),
          ),
          Effect.forkScoped,
        );
        yield* TestClock.adjust("17 seconds");
        expect(settled).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );
  });

  test("waitForSeqStrictE FAILS when calendar activation misses its echo", async () => {
    await expect(
      Effect.runPromise(waitForSeqStrictE(Number.MAX_SAFE_INTEGER, 20)),
    ).rejects.toThrow();
  });
});
