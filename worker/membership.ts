/// <reference types="@cloudflare/workers-types" />
import { Effect, Schema } from "effect";

import type { Membership } from "../src/data/membership-schema";

import { getPlan, type Plan } from "./plan";
import { giftWindow } from "./pro-reward";
import { isTrialEligible } from "./pro-trial";

class MembershipStorageError extends Schema.TaggedError<MembershipStorageError>()(
  "MembershipStorageError",
  { cause: Schema.Unknown },
) {}

// Classify D1 failures at the read boundary; projection defects stay defects.
const storage = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({
    try: read,
    catch: (cause) => new MembershipStorageError({ cause }),
  });

// Themes shipped free for a few hours on 2026-11-13. A read-only production
// check found exactly one non-owner account with Leaf saved. Cam chose to let
// that account keep Leaf. A stable ID keeps this exception small, independent
// of email changes, and out of customer-facing copy. It grants nothing else.
const LEGACY_LEAF_USER_ID = "N67xxLwtsZ7FA1YTv7u90gqF8y9k3i1f";
export const hasLegacyLeaf = (userId: string) => userId === LEGACY_LEAF_USER_ID;
export const canSaveTheme = (userId: string, plan: Plan, theme: string) =>
  theme === "default" ||
  plan !== "free" ||
  (hasLegacyLeaf(userId) && theme === "leaf");

export const readMembership = Effect.fn("Membership.read")(function* (
  db: D1Database,
  userId: string,
) {
  const { results } = yield* storage(() =>
    db
      .prepare(
        `SELECT plan, status, cancelAtPeriodEnd, cancelAt, periodEnd, billingInterval, stripeSubscriptionId, trialEnd,
        EXISTS(SELECT 1 FROM pro_reward r WHERE r.subscriptionId=subscription.stripeSubscriptionId AND r.state='applied') AS rewarded
       FROM subscription WHERE referenceId = ?`,
      )
      .bind(userId)
      .all<{
        plan: string;
        status: string;
        cancelAtPeriodEnd: number | null;
        stripeSubscriptionId: string | null;
        trialEnd: number | string | null;
        cancelAt: number | string | null;
        periodEnd: number | string | null;
        billingInterval: string | null;
        rewarded: number;
      }>(),
  );
  const plan = yield* storage(() => getPlan(userId, { DB: db }));
  const gift = yield* giftWindow(db, userId);
  const reward = yield* storage(() =>
    db
      .prepare(
        "SELECT message FROM pro_reward WHERE userId=? AND state IN ('pending','scheduled','review') ORDER BY createdAt DESC LIMIT 1",
      )
      .bind(userId)
      .first<{ message: string }>(),
  );
  const welcome = yield* storage(() =>
    db
      .prepare(
        `SELECT w.id, w.plan FROM membership_welcome w
     JOIN subscription s ON s.stripeSubscriptionId = w.id AND s.referenceId = w.userId
     WHERE w.userId = ? AND w.seenAt IS NULL AND s.status = 'active'
     ORDER BY w.createdAt DESC LIMIT 1`,
      )
      .bind(userId)
      .first<{ id: string; plan: "unlimited" | "founding" }>(),
  );
  return {
    plan,
    giftEndsAt:
      gift?.startsAt !== null && (gift?.startsAt ?? Infinity) <= Date.now()
        ? (gift?.endsAt ?? null)
        : null,
    rewardMessage: reward?.message ?? null,
    trialEligible:
      plan === "free" && (yield* storage(() => isTrialEligible(db, userId))),
    legacyLeaf: hasLegacyLeaf(userId),
    subs: results.map((row) => ({
      ...row,
      trialEnd:
        row.trialEnd === null ? null : new Date(row.trialEnd).toISOString(),
      periodEnd:
        row.periodEnd === null ? null : new Date(row.periodEnd).toISOString(),
      cancelAt:
        row.cancelAt === null ? null : new Date(row.cancelAt).toISOString(),
      rewarded: !!row.rewarded,
      cancelAtPeriodEnd: !!row.cancelAtPeriodEnd,
    })),
    welcome,
  } satisfies Membership;
});

export async function recordWelcome(
  db: D1Database,
  userId: string,
  subscriptionId: string,
  plan: string,
) {
  if (plan !== "unlimited" && plan !== "founding") return;
  await db
    .prepare(
      "INSERT OR IGNORE INTO membership_welcome (id, userId, plan, createdAt) VALUES (?, ?, ?, ?)",
    )
    .bind(subscriptionId, userId, plan, Date.now())
    .run();
}

export async function acknowledgeWelcome(
  db: D1Database,
  userId: string,
  id: string,
) {
  await db
    .prepare(
      "UPDATE membership_welcome SET seenAt = ? WHERE userId = ? AND id = ? AND seenAt IS NULL",
    )
    .bind(Date.now(), userId, id)
    .run();
}
