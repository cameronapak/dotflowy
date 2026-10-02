import { Schema } from "effect";

const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const Timestamp = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);

export const ExperimentalPreference = Schema.Literals([
  "enabled",
  "disabled",
  "unset",
  "unknown",
]);
export type ExperimentalPreference = typeof ExperimentalPreference.Type;

const SavedBetaPreference = Schema.Struct({
  id: Schema.Literal("lunora-beta"),
  enabled: Schema.Boolean,
});

/** Missing, explicit false, and malformed values are different evidence. */
export function savedExperimentalPreference(
  value: string | undefined,
): ExperimentalPreference {
  if (value === undefined) return "unset";
  const decoded = Schema.decodeUnknownOption(
    Schema.fromJsonString(SavedBetaPreference),
  )(value);
  if (decoded._tag === "None") return "unknown";
  return decoded.value.enabled ? "enabled" : "disabled";
}

export const ClassicAnalyticsMetadata = Schema.Struct({
  nodeCount: Count,
  experimentalPreference: ExperimentalPreference,
});
export type ClassicAnalyticsMetadata = typeof ClassicAnalyticsMetadata.Type;

export const ExperimentalAnalyticsMetadata = Schema.Struct({
  nodeCount: Count,
  nodesMigratedAt: Schema.NullOr(Timestamp),
  kvMigratedAt: Schema.NullOr(Timestamp),
});
export type ExperimentalAnalyticsMetadata =
  typeof ExperimentalAnalyticsMetadata.Type;

export const AnalyticsUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  createdAt: Timestamp,
  lastSessionCreatedAt: Schema.NullOr(Timestamp),
  isOwner: Schema.Boolean,
  experimentalPreference: ExperimentalPreference,
  classicNodeCount: Schema.NullOr(Count),
});
export type AnalyticsUser = typeof AnalyticsUser.Type;

export const AnalyticsSummary = Schema.Struct({
  registered: Count,
  joined7d: Count,
  joined30d: Count,
  retainedSession7d: Count,
  retainedSession30d: Count,
});

export const AdminAnalyticsReport = Schema.Struct({
  generatedAt: Timestamp,
  includeOwner: Schema.Boolean,
  ownerConfigured: Schema.Boolean,
  activityCoverage: Schema.Literal("not-installed"),
  population: Count,
  summary: AnalyticsSummary,
  users: Schema.Array(AnalyticsUser),
  nextCursor: Schema.NullOr(Schema.String),
});
export type AdminAnalyticsReport = typeof AdminAnalyticsReport.Type;

export const ExperimentalStorageReport = Schema.Struct({
  userId: Schema.String,
  checkedAt: Timestamp,
  metadata: Schema.NullOr(ExperimentalAnalyticsMetadata),
});
export type ExperimentalStorageReport = typeof ExperimentalStorageReport.Type;
