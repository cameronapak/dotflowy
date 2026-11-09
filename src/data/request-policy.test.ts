import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { withRequestBudget } from "./request-policy";

test("request policy bounds attempts and shares one timeout across retries", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let attempts = 0;
      const failed = yield* withRequestBudget(
        Effect.suspend(() => {
          attempts++;
          return Effect.fail("transport");
        }),
        () => "timeout",
      ).pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust("8 seconds");
      expect(yield* Fiber.join(failed)).toBe("transport");
      expect(attempts).toBe(5);

      attempts = 0;
      const slow = yield* withRequestBudget(
        Effect.suspend(() => {
          attempts++;
          return Effect.sleep("6 seconds").pipe(
            Effect.andThen(Effect.fail("transport")),
          );
        }),
        () => "timeout",
      ).pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust("8 seconds");
      expect(yield* Fiber.join(slow)).toBe("timeout");
      expect(attempts).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
