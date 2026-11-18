import { Schema } from "effect";

export const Reward = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals([
    "issued",
    "pending",
    "scheduled",
    "applied",
    "review",
    "revoked",
  ]),
  message: Schema.String,
  claimBy: Schema.Number,
  startsAt: Schema.NullOr(Schema.Number),
  endsAt: Schema.NullOr(Schema.Number),
});
export type Reward = typeof Reward.Type;
export const RewardResult = Schema.Struct({
  reward: Schema.NullOr(Reward),
  code: Schema.optionalKey(Schema.String),
});
export const RewardAdminAction = Schema.Struct({
  reportId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  action: Schema.Literals(["give", "retry"]),
  // Use the same reference for duplicate reports of one fixed bug.
  bug: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
});
export const RewardRedemption = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(80)),
  accountId: Schema.String.check(Schema.isMinLength(1)),
  consent: Schema.Literal(true),
});

const CodeId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16,64}$/));
export const ProCodeAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    id: CodeId,
    reason: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1000),
      Schema.isPattern(/\S/),
    ),
  }),
  Schema.Struct({
    action: Schema.Literals(["replace", "revoke", "retry"]),
    id: CodeId,
  }),
]);
export type ProCodeAction = typeof ProCodeAction.Type;
export const ProCode = Schema.Struct({
  ...Reward.fields,
  label: Schema.String,
  reason: Schema.String,
  createdAt: Schema.Number,
  claimedAt: Schema.NullOr(Schema.Number),
  redeemedBy: Schema.NullOr(Schema.String),
  status: Schema.Literals(["unused", "used", "expired", "revoked"]),
});
export type ProCode = typeof ProCode.Type;
export const ProCodes = Schema.Struct({
  codes: Schema.Array(ProCode),
  next: Schema.NullOr(Schema.String),
});
