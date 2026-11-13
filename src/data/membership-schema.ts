import { Schema } from "effect";

export const PaidPlanSchema = Schema.Literals(["unlimited", "founding"]);
export const WelcomeSchema = Schema.Struct({
  id: Schema.String,
  plan: PaidPlanSchema,
});
export const MembershipSchema = Schema.Struct({
  plan: Schema.Literals(["free", "unlimited", "founding"]),
  legacyLeaf: Schema.Boolean,
  subs: Schema.Array(
    Schema.Struct({
      plan: Schema.String,
      status: Schema.String,
      cancelAtPeriodEnd: Schema.Boolean,
    }),
  ),
  welcome: Schema.NullOr(WelcomeSchema),
});
export type Membership = typeof MembershipSchema.Type;
