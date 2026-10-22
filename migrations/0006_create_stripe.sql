-- Stripe billing tables (D1). The @better-auth/stripe plugin owns this
-- schema: `user.stripeCustomerId` maps a user to their Stripe customer, and
-- `subscription` holds webhook-maintained subscription state — `referenceId`
-- is the Better Auth `user.id` (never the email), `plan` + `status` are what
-- worker/plan.ts reads for entitlements. Free tier = no row. See issue #162.
--
-- Generated verbatim from better-auth@1.6.23 getMigrations() with the stripe
-- plugin added (an in-memory DB pre-seeded with 0003 + 0004, so this is the
-- exact diff). If auth options/plugins change the schema, re-generate and add
-- a new migration rather than editing this one.
alter table "user" add column "stripeCustomerId" text;

create table "subscription" ("id" text not null primary key, "plan" text not null, "referenceId" text not null, "stripeCustomerId" text, "stripeSubscriptionId" text, "status" text not null, "periodStart" date, "periodEnd" date, "trialStart" date, "trialEnd" date, "cancelAtPeriodEnd" integer, "cancelAt" date, "canceledAt" date, "endedAt" date, "seats" integer, "billingInterval" text, "stripeScheduleId" text);

-- Additive (not from the generator): getPlan() runs `WHERE referenceId = ?`
-- on every entitlement check, so give that read an index.
create index "subscription_referenceId_idx" on "subscription" ("referenceId");
