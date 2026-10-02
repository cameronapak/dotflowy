import { Schema } from "effect";

/** Matches the advance notice and revised policy. Never silently reuse a version. */
export const USAGE_POLICY_VERSION = "2026-10-02";

const Timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
export const UsageChoice = Schema.Literals(["accepted", "declined"]);
export type UsageChoice = typeof UsageChoice.Type;

export const UsageChoiceRequest = Schema.Struct({
  policyVersion: Schema.Literal(USAGE_POLICY_VERSION),
  choice: UsageChoice,
});

export const UsageConsentState = Schema.Struct({
  policyVersion: Schema.Literal(USAGE_POLICY_VERSION),
  choice: Schema.Literals(["unset", "accepted", "declined"]),
  decidedAt: Schema.NullOr(Timestamp),
  noticeAvailable: Schema.Boolean,
  collectionInstalled: Schema.Literal(false),
});
export type UsageConsentState = typeof UsageConsentState.Type;

export const UsageDailyRow = Schema.Struct({
  day: Schema.String,
  backend: Schema.Literals(["classic", "experimental"]),
  source: Schema.Literals(["browser", "mcp"]),
  activity: Schema.Literals(["opened", "edited"]),
});

export const UsageDataExport = Schema.Struct({
  consent: Schema.NullOr(
    Schema.Struct({
      policyVersion: Schema.String,
      choice: UsageChoice,
      decidedAt: Timestamp,
    }),
  ),
  daily: Schema.Array(UsageDailyRow),
});
