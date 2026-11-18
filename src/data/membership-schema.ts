import { Schema } from "effect";

export const PaidPlanSchema = Schema.Literals(["unlimited", "founding"]);
export const WelcomeSchema = Schema.Struct({
  id: Schema.String,
  plan: PaidPlanSchema,
});
export const MembershipSchema = Schema.Struct({
  plan: Schema.Literals(["free", "unlimited", "founding"]),
  // Optional while older Workers may still serve the previous projection.
  trialEligible: Schema.optionalKey(Schema.Boolean),
  giftEndsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  rewardMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
  legacyLeaf: Schema.Boolean,
  subs: Schema.Array(
    Schema.Struct({
      plan: Schema.String,
      status: Schema.String,
      cancelAtPeriodEnd: Schema.Boolean,
      stripeSubscriptionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      trialEnd: Schema.optionalKey(Schema.NullOr(Schema.String)),
      cancelAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      periodEnd: Schema.optionalKey(Schema.NullOr(Schema.String)),
      billingInterval: Schema.optionalKey(Schema.NullOr(Schema.String)),
      rewarded: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  welcome: Schema.NullOr(WelcomeSchema),
});
export type Membership = typeof MembershipSchema.Type;
