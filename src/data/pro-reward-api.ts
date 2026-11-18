import { Effect, Schema } from "effect";

import {
  RewardResult,
  type ProCodeAction,
  type RewardAdminAction,
  type RewardRedemption,
} from "./pro-reward";

export class RewardRequestError extends Schema.TaggedError<RewardRequestError>()(
  "RewardRequestError",
  {
    reason: Schema.Literals([
      "transport",
      "json",
      "schema",
      "server",
      "timeout",
      "missingReward",
    ]),
    message: Schema.String,
  },
) {}

export const saveReward = Effect.fn("saveReward")(
  function* (
    path: string,
    body:
      | typeof RewardAdminAction.Type
      | typeof RewardRedemption.Type
      | ProCodeAction,
  ) {
    // Keep cancellation attached through body consumption, not just headers.
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    );
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          referrerPolicy: "no-referrer",
          signal: AbortSignal.any([signal, controller.signal]),
        }),
      catch: () =>
        new RewardRequestError({
          reason: "transport",
          message:
            "Couldn't confirm delivery. Check your connection, then retry the same reward.",
        }),
    });
    const data: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new RewardRequestError({
          reason: "json",
          message: "Couldn't confirm delivery. Retry the same reward safely.",
        }),
    });
    if (!response.ok) {
      const error = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ error: Schema.String }),
      )(data).pipe(
        Effect.mapError(
          () =>
            new RewardRequestError({
              reason: "schema",
              message:
                "Couldn't confirm delivery. Retry the same reward safely.",
            }),
        ),
      );
      return yield* Effect.fail(
        new RewardRequestError({
          reason: "server",
          message: error.error,
        }),
      );
    }
    return yield* Schema.decodeUnknownEffect(RewardResult)(data).pipe(
      Effect.mapError(
        () =>
          new RewardRequestError({
            reason: "schema",
            message: "Couldn't confirm delivery. Retry the same reward safely.",
          }),
      ),
    );
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: "90 seconds",
    orElse: () =>
      Effect.fail(
        new RewardRequestError({
          reason: "timeout",
          message:
            "Couldn't confirm delivery. Check your connection, then retry the same reward.",
        }),
      ),
  }),
);
