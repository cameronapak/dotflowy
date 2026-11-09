import { Duration, Effect, Schedule } from "effect";

const retryPolicy = Schedule.max([
  Schedule.exponential("100 millis"),
  Schedule.recurs(4),
]);

/** The budget covers all attempts. Apply HTTP classification afterward so a
 * received error response never retries an already-committed write. */
export function withRequestBudget<A, E, R, Timeout>(
  request: Effect.Effect<A, E, R>,
  timeoutError: () => Timeout,
  retry = true,
): Effect.Effect<A, E | Timeout, R> {
  return (retry ? request.pipe(Effect.retry(retryPolicy)) : request).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(8),
      orElse: () => Effect.fail(timeoutError()),
    }),
  );
}
