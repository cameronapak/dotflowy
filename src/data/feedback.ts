import { Effect, Schema } from "effect";

import { withRequestBudget } from "./request-policy";

export const FeedbackKind = Schema.Literals(["bug", "idea", "question"]);
export type FeedbackKind = typeof FeedbackKind.Type;

/** Only coarse categories cross the boundary, never a URL or node identifier. */
export const FeedbackRoute = Schema.Literals(["outline", "settings", "other"]);

export const FeedbackContext = Schema.Struct({
  appVersion: Schema.String.check(
    Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
    Schema.isMaxLength(64),
  ),
  browser: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  routeCategory: Schema.optionalKey(FeedbackRoute),
});
export type FeedbackContext = typeof FeedbackContext.Type;

export const FeedbackSubmission = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16,64}$/)),
  kind: FeedbackKind,
  message: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5000),
    Schema.isPattern(/\S/),
  ),
  context: FeedbackContext,
});
export type FeedbackSubmission = typeof FeedbackSubmission.Type;

export const FeedbackReceipt = Schema.Struct({
  id: Schema.String,
  replayed: Schema.Boolean,
});

export class FeedbackClientError extends Schema.TaggedError<FeedbackClientError>()(
  "FeedbackClientError",
  { message: Schema.String },
) {}

/** Errors are fixed, safe copy: never echo the request or server diagnostics. */
export const submitFeedback = Effect.fn("Feedback.submit")(
  function* (submission: FeedbackSubmission) {
    const response = yield* Effect.tryPromise({
      try: (signal) => {
        // Don't transmit a node path or filter query through the Referer header.
        const options = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(submission),
          signal,
          referrerPolicy: "no-referrer" as const,
        };
        return fetch("/api/feedback", options);
      },
      catch: () =>
        new FeedbackClientError({
          message: "Couldn't send feedback. Your draft is here; please retry.",
        }),
    });
    if (!response.ok) {
      const messages = new Map([
        [401, "Sign in again, then retry your draft."],
        [
          403,
          "Ideas and questions require Pro or Founding. Bug reports are open to everyone.",
        ],
        [
          409,
          "This attempt conflicts with an earlier report. Edit your draft to start a new attempt.",
        ],
        [413, "This report is too large. Please shorten it and try again."],
        [
          429,
          "You've reached the feedback limit. Wait 24 hours and retry your draft.",
        ],
      ]);
      return yield* Effect.fail(
        new FeedbackClientError({
          message:
            messages.get(response.status) ??
            "Couldn't send feedback. Your draft is here; please retry.",
        }),
      );
    }
    const raw: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new FeedbackClientError({
          message: "Couldn't confirm delivery. Retry this draft safely.",
        }),
    });
    const receipt = yield* Schema.decodeUnknownEffect(FeedbackReceipt)(
      raw,
    ).pipe(
      Effect.mapError(
        () =>
          new FeedbackClientError({
            message: "Couldn't confirm delivery. Retry this draft safely.",
          }),
      ),
    );
    if (receipt.id !== submission.id)
      return yield* Effect.fail(
        new FeedbackClientError({
          message: "Couldn't confirm delivery. Retry this draft safely.",
        }),
      );
    return receipt;
  },
  (effect) =>
    withRequestBudget(
      effect,
      () =>
        new FeedbackClientError({
          message: "Delivery timed out. Retry this draft safely.",
        }),
      false,
    ),
);

/** Derive from pathname only; unknown routes deliberately lose all detail. */
export function feedbackRouteCategory(
  pathname: string,
): typeof FeedbackRoute.Type {
  if (pathname === "/settings" || pathname.startsWith("/settings/"))
    return "settings";
  if (pathname === "/" || pathname === "/today") return "outline";
  if (
    ["/demo", "/privacy", "/terms", "/reset-password"].includes(pathname) ||
    pathname.startsWith("/admin")
  )
    return "other";
  if (/^\/[^/]+$/.test(pathname)) return "outline";
  return "other";
}

export const PUBLIC_IDEA_URL =
  "https://github.com/cameronapak/dotflowy/issues/new?labels=enhancement";

let opener: ((kind: FeedbackKind) => void) | null = null;

export function setFeedbackOpener(fn: typeof opener) {
  opener = fn;
}

/** Existing menu/command consumers keep calling this; no GitHub bug redirect. */
export function openFeedbackReport(kind: FeedbackKind = "bug"): void {
  opener?.(kind);
}
