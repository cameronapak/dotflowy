/// <reference types="@cloudflare/workers-types" />
import { APIError } from "better-auth/api";
import { Effect, Schema } from "effect";
import Stripe from "stripe";

import {
  ProCodeAction,
  type ProCodes,
  RewardAdminAction,
  RewardRedemption,
  type Reward,
  type RewardResult,
} from "../src/data/pro-reward";
import { isAdminSession, type IdentityEnv } from "./identity";

export const REWARD_DAYS_MS = 30 * 86400_000;
const BILLABLE =
  "'active','trialing','past_due','unpaid','incomplete','paused'";
type Env = IdentityEnv & { DB: D1Database; STRIPE_SECRET_KEY?: string };
type Session = {
  user: { id: string; email: string; emailVerified?: boolean };
} | null;
interface Row extends Reward {
  gift: number;
  userId: string | null;
  reportId: number | null;
  reason: string;
  label: string;
  issuer: string;
  createdAt: number;
  codeHash: string | null;
  claimedAt: number | null;
  subscriptionId: string | null;
  originalEnd: number | null;
  priceId: string | null;
  attemptedAt: number | null;
}
class RewardError extends Schema.TaggedError<RewardError>()("RewardError", {
  status: Schema.Number,
  message: Schema.String,
}) {}
class RewardStorageError extends Schema.TaggedError<RewardStorageError>()(
  "RewardStorageError",
  { cause: Schema.Unknown },
) {}
class RewardProviderError extends Schema.TaggedError<RewardProviderError>()(
  "RewardProviderError",
  { cause: Schema.Unknown },
) {}
const fail = (message: string, status = 409) =>
  Effect.fail(new RewardError({ message, status }));
// Classify failures where they enter the program, not at the HTTP boundary.
const storage = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RewardStorageError({ cause }),
  });
const provider = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new RewardProviderError({ cause }),
  });
const stripeClient = Effect.fn("Rewards.stripeClient")(function* (env: Env) {
  if (!env.STRIPE_SECRET_KEY)
    return yield* fail("Billing is unavailable. The reward is not lost.", 503);
  return new Stripe(env.STRIPE_SECRET_KEY, {
    timeout: 20_000,
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(),
  });
});
const digest = Effect.fn("Rewards.digest")(function* (code: string) {
  const hash = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
});
const read = (db: D1Database, id: string) =>
  storage(() =>
    db.prepare("SELECT * FROM pro_reward WHERE id=?").bind(id).first<Row>(),
  );
const publicReward = (r: Row): Reward => ({
  id: r.id,
  state: r.state,
  message: r.message,
  claimBy: r.claimBy,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
});

function locked<A, E, R>(
  db: D1Database,
  userId: string,
  work: Effect.Effect<A, E, R>,
) {
  const acquire = Effect.gen(function* () {
    const token = crypto.randomUUID();
    const now = Date.now();
    const lock = yield* storage(() =>
      db
        .prepare(`INSERT INTO pro_reward_lock (userId,token,untilAt) VALUES (?1,?2,?3)
    ON CONFLICT(userId) DO UPDATE SET token=?2,untilAt=?3 WHERE untilAt<=?4 RETURNING token`)
        .bind(userId, token, now + 300_000, now)
        .first(),
    );
    if (!lock)
      return yield* fail(
        "A membership change is in progress. Retry in a moment.",
      );
    return token;
  });
  return Effect.acquireUseRelease(
    acquire,
    () => work,
    (token) =>
      storage(() =>
        db
          .prepare("DELETE FROM pro_reward_lock WHERE userId=? AND token=?")
          .bind(userId, token)
          .run(),
      ).pipe(Effect.asVoid),
  );
}
export { locked as withMembershipLock };

/** One query shared by all server access checks and the membership projection.
 * A gift never creates a subscription or depends on a cron to expire. */
export const giftWindow = (db: D1Database, userId: string) =>
  storage(() =>
    db
      .prepare(`SELECT MIN(startsAt) AS startsAt, MAX(endsAt) AS endsAt FROM pro_reward
    WHERE userId=?1 AND state='applied' AND gift=1 AND endsAt>?2`)
      .bind(userId, Date.now())
      .first<{ startsAt: number | null; endsAt: number | null }>(),
  );

const customerId = (s: Stripe.Subscription) =>
  Schema.is(Schema.String)(s.customer) ? s.customer : s.customer.id;
const millis = (seconds: number | null) =>
  seconds === null ? null : seconds * 1000;

/** The plugin owns row creation. For reward accounts only, repair its mirror
 * from a fresh Stripe read, never a potentially old webhook snapshot. Throws
 * if plugin persistence failed, making the verified webhook retryable. */
const mirror = Effect.fn("Rewards.mirror")(function* (
  db: D1Database,
  userId: string,
  s: Stripe.Subscription,
) {
  const item = s.items.data[0];
  if (!item) return yield* fail("Subscription has no plan. Review billing.");
  const result = yield* storage(() =>
    db
      .prepare(`UPDATE subscription SET status=?,periodStart=?,periodEnd=?,trialStart=?,trialEnd=?,
    cancelAtPeriodEnd=?,cancelAt=?,canceledAt=?,endedAt=?,billingInterval=?
    WHERE referenceId=? AND stripeSubscriptionId=? RETURNING id`)
      .bind(
        s.status,
        item.current_period_start * 1000,
        item.current_period_end * 1000,
        millis(s.trial_start),
        millis(s.trial_end),
        Number(s.cancel_at_period_end),
        millis(s.cancel_at),
        millis(s.canceled_at),
        millis(s.ended_at),
        item.price.recurring?.interval ?? null,
        userId,
        s.id,
      )
      .first(),
  );
  if (!result)
    return yield* fail(
      "Subscription synchronization is pending. Retry safely.",
      503,
    );
});

const review = (db: D1Database, id: string, message: string) =>
  storage(() =>
    db
      .prepare("UPDATE pro_reward SET state='review',message=? WHERE id=?")
      .bind(message, id)
      .run(),
  );

const settledInvoices = Effect.fn("Rewards.settledInvoices")(function* (
  stripe: Stripe,
  customer: string,
) {
  const invoices = yield* provider(() =>
    stripe.invoices.list({ customer, limit: 100 }),
  );
  if (
    invoices.has_more ||
    invoices.data.some((i) =>
      ["open", "draft", "uncollectible"].includes(i.status ?? ""),
    )
  )
    return yield* fail(
      "An invoice needs review before granting time. The reward is not consumed.",
    );
  const pending = yield* provider(() =>
    stripe.invoiceItems.list({
      customer,
      pending: true,
      limit: 1,
    }),
  );
  if (pending.data.length)
    return yield* fail(
      "Pending invoice items need review. The reward is not consumed.",
    );
  return invoices;
});

/** Refuse billing complexity rather than quietly forgive invoices or move a
 * charge that might already be in flight. A 24h margin also covers Stripe's
 * normal advance invoice generation; external Dashboard edits still require
 * post-write verification and manual handling of any uncertain outcome. */
const boundary = Effect.fn("Rewards.boundary")(function* (
  stripe: Stripe,
  s: Stripe.Subscription,
  now: number,
) {
  const item = s.items.data[0];
  if (
    (s.status !== "active" && s.status !== "trialing") ||
    s.pause_collection ||
    s.pending_update ||
    s.schedule ||
    s.items.data.length !== 1 ||
    !item ||
    item.quantity !== 1 ||
    !["dotflowy_unlimited_monthly", "dotflowy_unlimited_annual"].includes(
      item.price.lookup_key ?? "",
    ) ||
    item.price.billing_scheme !== "per_unit" ||
    item.price.recurring?.usage_type !== "licensed" ||
    s.discounts.length ||
    item.discounts?.length ||
    s.pending_invoice_item_interval ||
    s.collection_method !== "charge_automatically"
  )
    return yield* fail(
      "This billing setup needs manual review. The reward is not consumed.",
    );
  const end = s.status === "trialing" ? s.trial_end : item.current_period_end;
  if (!end || end * 1000 - now < 86400_000)
    return yield* fail(
      "Renewal is too close or in progress. Retry after billing settles.",
    );
  const invoices = yield* settledInvoices(stripe, customerId(s));
  if (s.status === "active") {
    const latestId = Schema.is(Schema.String)(s.latest_invoice)
      ? s.latest_invoice
      : s.latest_invoice?.id;
    const invoice = invoices.data.find((i) => i.id === latestId);
    const line = invoice?.lines.data.find(
      (l) =>
        l.period.end === end &&
        l.period.start <= now / 1000 &&
        l.parent?.subscription_item_details?.subscription === s.id &&
        l.parent.subscription_item_details.subscription_item === item.id &&
        l.pricing?.price_details?.price === item.price.id &&
        l.parent.subscription_item_details.proration === false,
    );
    if (
      !invoice ||
      invoice.status !== "paid" ||
      invoice.amount_remaining !== 0 ||
      invoice.amount_paid <= 0 ||
      !line ||
      invoice.lines.has_more
    )
      return yield* fail(
        "Paid coverage could not be verified. Review the invoice before granting time.",
      );
  }
  return end * 1000;
});

const apply = Effect.fn("Rewards.apply")(function* (
  db: D1Database,
  stripe: Stripe | null,
  r: Row,
) {
  if (r.state === "applied" || r.state === "revoked" || r.state === "issued")
    return;
  const userId = r.userId;
  if (!userId)
    return yield* fail("Claim this code before delivering its reward.");
  const now = Date.now();
  const account = yield* storage(() =>
    db
      .prepare(
        "SELECT stripeCustomerId FROM user WHERE id=? AND emailVerified=1",
      )
      .bind(r.userId)
      .first<{ stripeCustomerId: string | null }>(),
  );
  if (!account) return yield* fail("A verified account is required.");
  if (
    r.attemptedAt === null &&
    (yield* storage(() =>
      db
        .prepare(`SELECT userId FROM membership_checkout WHERE userId=?1 AND expiresAt>?2
    UNION ALL SELECT userId FROM pro_trial_checkout WHERE userId=?1 AND expiresAt>?2 AND usedAt IS NULL`)
        .bind(r.userId, now)
        .first(),
    ))
  )
    return yield* fail(
      "Checkout is still open or uncertain. Finish it or wait for its expiry, then retry the same reward.",
    );
  const local = yield* storage(() =>
    db
      .prepare(
        `SELECT stripeSubscriptionId FROM subscription WHERE referenceId=? AND status IN (${BILLABLE})
       AND (status<>'incomplete' OR stripeSubscriptionId IS NOT NULL)`,
      )
      .bind(r.userId)
      .all<{ stripeSubscriptionId: string | null }>(),
  );
  if (local.results.some((s) => !s.stripeSubscriptionId))
    return yield* fail(
      "An indefinite comp or Founding membership needs manual review.",
    );
  let sub: Stripe.Subscription | undefined;
  if (account.stripeCustomerId) {
    if (!stripe)
      return yield* fail("Billing is unavailable. Retry safely.", 503);
    const customer = account.stripeCustomerId;
    const subscriptions = yield* provider(() =>
      stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      }),
    );
    const billable = subscriptions.data.filter(
      (s) => !["canceled", "incomplete_expired"].includes(s.status),
    );
    if (subscriptions.has_more || billable.length > 1)
      return yield* fail("Multiple subscriptions need manual review.");
    sub = billable[0];
  } else if (local.results.length)
    return yield* fail("Billing identity needs manual review.");

  // Once a fixed Stripe target exists, NEVER recalculate from a retry's end.
  if (r.attemptedAt !== null) {
    if (!stripe || !sub || sub.id !== r.subscriptionId)
      return yield* fail(
        "The subscription changed during delivery. Review the pending reward.",
      );
    if (
      sub.metadata.dotflowyReward === r.id &&
      millis(sub.trial_end) === r.endsAt &&
      sub.items.data[0]?.price.id === r.priceId
    ) {
      if (
        sub.billing_cycle_anchor * 1000 !== r.endsAt ||
        (sub.cancel_at && sub.cancel_at * 1000 < (r.endsAt ?? Infinity)) ||
        (sub.status !== "trialing" && sub.status !== "active")
      )
        return yield* fail(
          "The delivered extension changed. Review billing without adding time again.",
        );
      yield* mirror(db, userId, sub);
      yield* storage(() =>
        db
          .prepare(
            "UPDATE pro_reward SET state='applied',message='Renewal moved by 30 days; your plan and billing interval stay the same.' WHERE id=?",
          )
          .bind(r.id)
          .run(),
      );
      return;
    }
    // Inspect first even within the idempotency window. Cancellations/plan edits
    // never get overwritten by a stale retry. After 23h, no automatic writes.
    if (
      now - r.attemptedAt > 23 * 3600_000 ||
      sub.cancel_at ||
      sub.cancel_at_period_end ||
      sub.items.data[0]?.price.id !== r.priceId ||
      (sub.status === "trialing"
        ? millis(sub.trial_end)
        : sub.items.data[0]?.current_period_end * 1000) !== r.originalEnd
    )
      return yield* fail(
        "Delivery is uncertain or billing changed. Check Stripe before retrying; no extra time was added.",
      );
    yield* boundary(stripe, sub, now);
  } else {
    if (!sub) {
      if (r.state === "scheduled") {
        // Reconcile scheduled cancellations only through the verified lifecycle.
        return;
      }
      if (r.subscriptionId && r.originalEnd)
        return yield* fail(
          "This cancellation needs manual review before delivering time.",
        );
      if (
        yield* storage(() =>
          db
            .prepare(
              "SELECT id FROM pro_reward WHERE userId=? AND id<>? AND state='scheduled' LIMIT 1",
            )
            .bind(userId, r.id)
            .first(),
        )
      )
        return yield* fail(
          "A cancellation reward is awaiting confirmation. Resolve it before delivering another gift.",
        );
      if (stripe && account.stripeCustomerId)
        yield* settledInvoices(stripe, account.stripeCustomerId);
      const gift = yield* giftWindow(db, userId);
      const start = Math.max(now, gift?.endsAt ?? now);
      yield* storage(() =>
        db
          .prepare(
            "UPDATE pro_reward SET state='applied',gift=1,startsAt=?,endsAt=?,message='30 days of Pro. No card, subscription or automatic renewal.' WHERE id=? AND state<>'applied' AND attemptedAt IS NULL",
          )
          .bind(start, start + REWARD_DAYS_MS, r.id)
          .run(),
      );
      return;
    }
    if (!stripe) return yield* fail("Billing is unavailable.", 503);
    yield* mirror(db, userId, sub);
    const end = yield* boundary(stripe, sub, now);
    if (sub.cancel_at || sub.cancel_at_period_end) {
      const cutoff = Math.min(end, millis(sub.cancel_at) ?? end);
      yield* storage(() =>
        db
          .prepare(
            "UPDATE pro_reward SET state='scheduled',subscriptionId=?,originalEnd=?,message='30 bonus days after existing access ends. Your cancellation stays in place.' WHERE id=? AND state<>'applied' AND attemptedAt IS NULL",
          )
          .bind(sub.id, cutoff, r.id)
          .run(),
      );
      return;
    }
    const subscriptionId = sub.id;
    const fresh = yield* provider(() =>
      stripe.subscriptions.retrieve(subscriptionId),
    );
    if (
      fresh.status !== sub.status ||
      fresh.cancel_at ||
      fresh.cancel_at_period_end ||
      fresh.latest_invoice !== sub.latest_invoice ||
      fresh.items.data[0]?.price.id !== sub.items.data[0]?.price.id ||
      (fresh.status === "trialing"
        ? millis(fresh.trial_end)
        : millis(fresh.items.data[0]?.current_period_end ?? null)) !== end
    )
      return yield* fail(
        "Billing changed while checking coverage. Retry after it settles.",
      );
    // No gifted access should overlap a second paid subscription.
    const gift = yield* giftWindow(db, userId);
    if (gift?.endsAt && gift.endsAt > end)
      return yield* fail(
        "Existing gifted access needs review before moving renewal.",
      );
    const priceId = sub.items.data[0]?.price.id;
    if (!priceId)
      return yield* fail("Subscription has no plan. Review billing.");
    yield* storage(() =>
      db
        .prepare(
          "UPDATE pro_reward SET state='pending',subscriptionId=?,originalEnd=?,startsAt=?,endsAt=?,priceId=?,attemptedAt=?,message='Verifying renewal extension. Retry this same reward safely.' WHERE id=? AND attemptedAt IS NULL AND state<>'applied'",
        )
        .bind(sub.id, end, end, end + REWARD_DAYS_MS, priceId, now, r.id)
        .run(),
    );
    const fixed = yield* read(db, r.id);
    if (!fixed) return yield* fail("Reward disappeared.");
    if (fixed.state === "applied") return;
    r = fixed;
  }
  if (!stripe || !sub || !r.endsAt || r.subscriptionId !== sub.id)
    return yield* fail("Reward is not ready.");
  const target = r.endsAt;
  const subscriptionId = sub.id;
  // The key and target were persisted BEFORE this first possible network write.
  yield* provider(() =>
    stripe.subscriptions.update(
      subscriptionId,
      {
        trial_end: target / 1000,
        proration_behavior: "none",
        metadata: { dotflowyReward: r.id },
      },
      { idempotencyKey: `pro-reward-${r.id}` },
    ),
  );
  const current = yield* provider(() =>
    stripe.subscriptions.retrieve(subscriptionId),
  );
  if (
    current.metadata.dotflowyReward !== r.id ||
    millis(current.trial_end) !== r.endsAt ||
    current.billing_cycle_anchor * 1000 !== r.endsAt ||
    current.items.data[0]?.price.id !== r.priceId ||
    current.cancel_at !== sub.cancel_at ||
    current.cancel_at_period_end !== sub.cancel_at_period_end ||
    current.status !== "trialing"
  )
    return yield* fail(
      "Billing changed during delivery. Review this pending reward before promising dates.",
    );
  yield* mirror(db, userId, current);
  yield* storage(() =>
    db
      .prepare(
        "UPDATE pro_reward SET state='applied',message='Renewal moved by 30 days; your plan and billing interval stay the same.' WHERE id=?",
      )
      .bind(r.id)
      .run(),
  );
});

const deliver = Effect.fn("Rewards.deliver")(function* (env: Env, r: Row) {
  const stripe = env.STRIPE_SECRET_KEY ? yield* stripeClient(env) : null;
  yield* apply(env.DB, stripe, r).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "RewardError" || error._tag === "RewardProviderError",
      (error) =>
        Effect.gen(function* () {
          // Target-bearing operations retain their durable pending state on failure.
          // They cannot be replaced by another reward for the same account.
          const current = yield* read(env.DB, r.id);
          if (current?.state === "applied" || current?.state === "revoked")
            return;
          if (current?.attemptedAt === null && current.state !== "scheduled")
            yield* review(
              env.DB,
              r.id,
              error._tag === "RewardError"
                ? error.message
                : "Billing could not be checked. Retry safely.",
            );
          else if (current)
            yield* storage(() =>
              env.DB.prepare("UPDATE pro_reward SET message=? WHERE id=?")
                .bind(
                  error._tag === "RewardError"
                    ? error.message
                    : "Stripe delivery is unconfirmed. Retry this same reward safely.",
                  r.id,
                )
                .run(),
            );
          if (error._tag === "RewardProviderError" || error.status >= 500)
            return yield* Effect.fail(error);
        }),
    ),
  );
});

/** Called after signature verification, including deleted events. Lock before
 * fetching so duplicate/out-of-order callbacks converge on current state. */
export const reconcileRewards = Effect.fn("Rewards.reconcile")(function* (
  env: Env,
  subscriptionId: string,
) {
  const owner = yield* storage(() =>
    env.DB.prepare(
      "SELECT userId FROM pro_reward WHERE subscriptionId=? LIMIT 1",
    )
      .bind(subscriptionId)
      .first<{ userId: string }>(),
  );
  if (!owner) return;
  yield* locked(
    env.DB,
    owner.userId,
    Effect.gen(function* () {
      const stripe = yield* stripeClient(env);
      const current = yield* provider(() =>
        stripe.subscriptions.retrieve(subscriptionId),
      );
      yield* mirror(env.DB, owner.userId, current);
      const { results } = yield* storage(() =>
        env.DB.prepare(
          "SELECT * FROM pro_reward WHERE subscriptionId=? AND state IN ('pending','scheduled') ORDER BY createdAt,id",
        )
          .bind(subscriptionId)
          .all<Row>(),
      );
      for (const reward of results) {
        if (reward.state === "scheduled" && current.status === "canceled") {
          yield* settledInvoices(stripe, customerId(current));
          if (
            !current.ended_at ||
            current.ended_at * 1000 < (reward.originalEnd ?? Infinity) - 60_000
          ) {
            yield* review(
              env.DB,
              reward.id,
              "Subscription ended early. Review the reward without restarting billing.",
            );
            continue;
          }
          const gift = yield* giftWindow(env.DB, owner.userId);
          // Historical gifts still occupy their earned slot when reconciliation
          // is delayed past their expiry; entitlement reads intentionally omit them.
          const previous = yield* storage(() =>
            env.DB.prepare(
              "SELECT MAX(endsAt) AS endsAt FROM pro_reward WHERE userId=? AND subscriptionId=? AND state='applied' AND gift=1",
            )
              .bind(owner.userId, subscriptionId)
              .first<{ endsAt: number | null }>(),
          );
          const start = Math.max(
            current.ended_at * 1000,
            gift?.endsAt ?? 0,
            previous?.endsAt ?? 0,
          );
          yield* storage(() =>
            env.DB.prepare(
              "UPDATE pro_reward SET state='applied',gift=1,startsAt=?,endsAt=?,message='30-day thank-you gift. Billing remains canceled; no automatic renewal.' WHERE id=? AND state='scheduled'",
            )
              .bind(start, start + REWARD_DAYS_MS, reward.id)
              .run(),
          );
        } else if (
          reward.state === "pending" ||
          (!current.cancel_at && !current.cancel_at_period_end)
        ) {
          yield* apply(env.DB, stripe, reward);
        }
      }
    }),
  );
});

/** Carry remaining gift time into deliberate Pro checkout, never consume it
 * for merely opening/abandoning Checkout. Founding's 3-year plan is excluded. */
export const giftCheckoutParams = (
  db: D1Database,
  userId: string,
  plan: string,
  annual: boolean,
) =>
  locked(
    db,
    userId,
    Effect.gen(function* () {
      const now = Date.now();
      const gift = yield* giftWindow(db, userId);
      if (gift?.endsAt && plan !== "unlimited")
        return yield* fail(
          "Enjoy your Pro gift first, or contact support before choosing Founding.",
        );
      if (gift?.endsAt && gift.endsAt - now < 48 * 3600_000)
        return yield* fail(
          "Your gift ends soon. Start a subscription after it ends so no gift time is lost.",
        );
      if (
        yield* storage(() =>
          db
            .prepare(
              "SELECT userId FROM pro_trial_checkout WHERE userId=? AND usedAt IS NULL AND expiresAt>?",
            )
            .bind(userId, now)
            .first(),
        )
      )
        return yield* fail(
          "Trial checkout is still open or uncertain. Finish it or wait for its expiry before starting another checkout.",
        );
      if (
        yield* storage(() =>
          db
            .prepare(
              "SELECT id FROM pro_reward WHERE userId=? AND state IN ('pending','scheduled')",
            )
            .bind(userId)
            .first(),
        )
      )
        return yield* fail(
          "A reward is pending. Resolve it before starting checkout.",
        );
      yield* storage(() =>
        db
          .prepare(`INSERT INTO membership_checkout (userId,attemptId,plan,annual,expiresAt,giftEnd) VALUES (?,?,?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET attemptId=excluded.attemptId,plan=excluded.plan,annual=excluded.annual,expiresAt=excluded.expiresAt,giftEnd=excluded.giftEnd WHERE membership_checkout.expiresAt<=?`)
          .bind(
            userId,
            crypto.randomUUID(),
            plan,
            Number(annual),
            now + 3600_000,
            gift?.endsAt ?? null,
            now,
          )
          .run(),
      );
      const reservation = yield* storage(() =>
        db
          .prepare("SELECT * FROM membership_checkout WHERE userId=?")
          .bind(userId)
          .first<{
            attemptId: string;
            plan: string;
            annual: number;
            expiresAt: number;
            giftEnd: number | null;
          }>(),
      );
      if (
        !reservation ||
        reservation.plan !== plan ||
        reservation.annual !== Number(annual) ||
        reservation.expiresAt - now < 31 * 60_000
      )
        return yield* fail(
          "A checkout is already open. Finish it or wait up to an hour before choosing another plan.",
        );
      const params: Stripe.Checkout.SessionCreateParams = {
        expires_at: Math.floor(reservation.expiresAt / 1000),
        metadata: {
          dotflowyCheckout: reservation.attemptId,
          dotflowyCheckoutUser: userId,
        },
        subscription_data: {
          metadata: {
            dotflowyCheckout: reservation.attemptId,
            dotflowyCheckoutUser: userId,
          },
        },
      };
      if (reservation.giftEnd) {
        params.metadata = { ...params.metadata, dotflowyGift: userId };
        params.subscription_data = {
          ...params.subscription_data,
          trial_end: Math.ceil(reservation.giftEnd / 1000),
          metadata: {
            ...params.subscription_data?.metadata,
            dotflowyGift: userId,
          },
        };
      }
      return {
        params,
        options: {
          idempotencyKey: `membership-${userId}-${reservation.attemptId}`,
        },
      };
    }),
  ).pipe(
    Effect.catchTag("RewardError", (error) =>
      Effect.fail(new APIError("CONFLICT", { message: error.message })),
    ),
  );

/** Verified completion settles only its own checkout attempt. A stale webhook
 * cannot remove a newer reservation or transfer its gifted access. */
export const reconcileMembershipCheckout = Effect.fn(
  "Rewards.reconcileCheckout",
)(function* (
  env: Env,
  subscriptionId: string,
  userId: string,
  attemptId: string,
) {
  yield* locked(
    env.DB,
    userId,
    Effect.gen(function* () {
      const reservation = yield* storage(() =>
        env.DB.prepare(
          "SELECT giftEnd FROM membership_checkout WHERE userId=? AND attemptId=?",
        )
          .bind(userId, attemptId)
          .first<{ giftEnd: number | null }>(),
      );
      // The handoff is one-time. Later lifecycle updates must not consume a
      // new gift issued after cancellation of this same subscription.
      if (!reservation) return;
      const stripe = yield* stripeClient(env);
      const current = yield* provider(() =>
        stripe.subscriptions.retrieve(subscriptionId),
      );
      const user = yield* storage(() =>
        env.DB.prepare("SELECT stripeCustomerId FROM user WHERE id=?")
          .bind(userId)
          .first<{ stripeCustomerId: string }>(),
      );
      if (
        !user ||
        customerId(current) !== user.stripeCustomerId ||
        current.metadata.dotflowyCheckout !== attemptId ||
        current.metadata.dotflowyCheckoutUser !== userId
      )
        return yield* fail("Checkout synchronization needs review.", 503);
      if (current.status !== "active" && current.status !== "trialing") return;
      const giftEnd = reservation.giftEnd;
      if (giftEnd !== null) {
        const gift = yield* giftWindow(env.DB, userId);
        if (
          current.metadata.dotflowyGift !== userId ||
          !current.trial_end ||
          current.trial_end * 1000 < giftEnd ||
          (current.cancel_at && current.cancel_at * 1000 < giftEnd) ||
          (current.cancel_at_period_end &&
            current.items.data.some(
              (item) => item.current_period_end * 1000 < giftEnd,
            )) ||
          (gift?.endsAt && current.trial_end * 1000 < gift.endsAt)
        )
          return yield* fail(
            "Gift checkout synchronization needs review.",
            503,
          );
        const trialEnd = current.trial_end * 1000;
        yield* mirror(env.DB, userId, current);
        yield* storage(() =>
          env.DB.prepare(
            "UPDATE pro_reward SET gift=0,subscriptionId=? WHERE userId=? AND state='applied' AND gift=1 AND endsAt<=?",
          )
            .bind(current.id, userId, trialEnd)
            .run(),
        );
      }
      yield* storage(() =>
        env.DB.prepare(
          "DELETE FROM membership_checkout WHERE userId=? AND attemptId=?",
        )
          .bind(userId, attemptId)
          .run(),
      );
    }),
  );
});

const json = (
  body: typeof RewardResult.Type | typeof ProCodes.Type | { error: string },
  status = 200,
) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });

const codeHistory = Effect.fn("Rewards.history")(function* (
  db: D1Database,
  before: string | null,
) {
  const cursor = before ? yield* read(db, before) : null;
  if (before && !cursor)
    return yield* fail("Code history cursor not found.", 404);
  const page = yield* storage(() =>
    db
      .prepare(`SELECT r.*,u.email FROM pro_reward r LEFT JOIN user u ON u.id=r.userId
    WHERE r.codeHash IS NOT NULL AND (?1 IS NULL OR r.createdAt<?1 OR (r.createdAt=?1 AND r.id<?2))
    ORDER BY r.createdAt DESC,r.id DESC LIMIT 51`)
      .bind(cursor?.createdAt ?? null, cursor?.id ?? "")
      .all<Row & { email: string | null }>(),
  );
  const rows = page.results.slice(0, 50);
  return {
    codes: rows.map((r): (typeof ProCodes.Type)["codes"][number] => ({
      ...publicReward(r),
      label: r.label,
      reason: r.reason,
      createdAt: r.createdAt,
      claimedAt: r.claimedAt,
      redeemedBy: r.email,
      status:
        r.claimedAt !== null
          ? "used"
          : r.state === "revoked"
            ? "revoked"
            : r.claimBy <= Date.now()
              ? "expired"
              : "unused",
    })),
    next: page.results.length > 50 ? (rows.at(-1)?.id ?? null) : null,
  };
});

const manageCode = Effect.fn("Rewards.manageCode")(function* (
  env: Env,
  action: ProCodeAction,
  issuer: string,
) {
  if (action.action === "create" || action.action === "replace") {
    const code = `DF-${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const hash = yield* digest(code);
    const label = `${code.slice(0, 11)}…${code.slice(-6)}`;
    if (action.action === "create") {
      const saved = yield* storage(() =>
        env.DB.prepare(`INSERT INTO pro_reward
        (id,bug,issuer,createdAt,reason,label,codeHash,claimBy,state)
        VALUES (?,?,?,?,?,?,?,?,'issued') ON CONFLICT(id) DO NOTHING`)
          .bind(
            action.id,
            `code:${action.id}`,
            issuer,
            Date.now(),
            action.reason.trim(),
            label,
            hash,
            Date.now() + 90 * 86400_000,
          )
          .run(),
      );
      const r = yield* read(env.DB, action.id);
      if (
        !r ||
        !r.codeHash ||
        r.issuer !== issuer ||
        r.reason !== action.reason.trim()
      )
        return yield* fail(
          "This creation attempt already belongs to another reward.",
        );
      return json({
        reward: publicReward(r),
        code: saved.meta.changes ? code : undefined,
      });
    }
    const changed = yield* storage(() =>
      env.DB.prepare(`UPDATE pro_reward SET codeHash=?,label=?,claimBy=?
      WHERE id=? AND codeHash IS NOT NULL AND userId IS NULL AND state='issued' AND claimedAt IS NULL RETURNING id`)
        .bind(hash, label, Date.now() + 90 * 86400_000, action.id)
        .first(),
    );
    if (!changed)
      return yield* fail("Only unclaimed, unrevoked codes can be replaced.");
    const r = yield* read(env.DB, action.id);
    return json({ reward: r ? publicReward(r) : null, code });
  }
  if (action.action === "revoke") {
    const changed = yield* storage(() =>
      env.DB.prepare(`UPDATE pro_reward SET state='revoked',message='Unclaimed code revoked.'
      WHERE id=? AND codeHash IS NOT NULL AND userId IS NULL AND claimedAt IS NULL AND state IN ('issued','revoked') RETURNING id`)
        .bind(action.id)
        .first(),
    );
    if (!changed)
      return yield* fail(
        "Only unclaimed codes can be revoked. Delivered time is never shortened.",
      );
    const r = yield* read(env.DB, action.id);
    return json({ reward: r ? publicReward(r) : null });
  }
  const r = yield* read(env.DB, action.id);
  if (!r?.codeHash || !r.userId)
    return yield* fail("This code has not been claimed.");
  return yield* locked(
    env.DB,
    r.userId,
    Effect.gen(function* () {
      const current = yield* read(env.DB, r.id);
      if (!current) return yield* fail("Reward not found.", 404);
      yield* claimAndDeliver(env, current);
      const updated = yield* read(env.DB, r.id);
      return json({ reward: updated ? publicReward(updated) : null });
    }),
  );
});

const invalidInput = () =>
  new RewardError({
    status: 400,
    message:
      "Couldn't read the reward request. Check the fields and try again.",
  });

const readInput = Effect.fn("Rewards.readInput")(function* (
  body: ReadableStream<Uint8Array>,
) {
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let length = 0;
        while (true) {
          const chunk = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: invalidInput,
          });
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 8192) {
            yield* Effect.tryPromise({
              try: () => reader.cancel(),
              catch: invalidInput,
            });
            return yield* fail("input too large", 413);
          }
          chunks.push(new Uint8Array(chunk.value));
        }
        const raw = yield* Effect.tryPromise({
          try: () => new Blob(chunks).text(),
          catch: invalidInput,
        });
        return yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(raw).pipe(Effect.mapError(invalidInput));
      }),
    (reader) => Effect.sync(() => reader.releaseLock()),
  );
});

export const handleRewards = Effect.fn("Rewards.request")(
  function* (request: Request, env: Env, session: Session, admin: boolean) {
    if (admin && !isAdminSession(session, env))
      return json({ error: "not found" }, 404);
    if (!session) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const codes = admin && url.pathname === "/api/admin/pro-codes";
    if (request.method === "GET" && admin) {
      if (codes)
        return json(yield* codeHistory(env.DB, url.searchParams.get("before")));
      const r = yield* storage(() =>
        env.DB.prepare("SELECT * FROM pro_reward WHERE reportId=?")
          .bind(Number(url.searchParams.get("reportId")))
          .first<Row>(),
      );
      return json({ reward: r ? publicReward(r) : null });
    }
    if (request.method !== "POST")
      return json({ error: "method not allowed" }, 405);
    if (
      !/^application\/json(?:;|$)/i.test(
        request.headers.get("content-type") ?? "",
      ) ||
      request.headers.get("origin") !== url.origin
    )
      return json({ error: "invalid origin or content type" }, 403);
    if (!request.body) return json({ error: "missing input" }, 400);
    const input = yield* readInput(request.body);
    if (codes) {
      const action = yield* Schema.decodeUnknownEffect(ProCodeAction)(input, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(invalidInput));
      return yield* manageCode(env, action, session.user.id);
    }
    if (admin) {
      const a = yield* Schema.decodeUnknownEffect(RewardAdminAction)(input, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(invalidInput));
      const report = yield* storage(() =>
        env.DB.prepare(`SELECT f.user_id AS userId FROM feedback_submissions f JOIN user u ON u.id=f.user_id
        WHERE f.id=? AND f.kind='bug' AND f.completed_at IS NOT NULL AND u.emailVerified=1`)
          .bind(a.reportId)
          .first<{ userId: string }>(),
      );
      if (!report)
        return yield* fail(
          "Mark a fixed bug complete and verify the reporter's account first.",
        );
      return yield* locked(
        env.DB,
        report.userId,
        Effect.gen(function* () {
          let r = yield* storage(() =>
            env.DB.prepare("SELECT * FROM pro_reward WHERE reportId=?")
              .bind(a.reportId)
              .first<Row>(),
          );
          if (!r) {
            if (a.action === "retry")
              return yield* fail("No reward has been created.");
            const duplicate = yield* storage(() =>
              env.DB.prepare(
                "SELECT id FROM pro_reward WHERE userId=? AND bug=?",
              )
                .bind(report.userId, a.bug.trim())
                .first(),
            );
            if (duplicate)
              return yield* fail(
                "This account has already been rewarded for that fixed bug. Use the original report to check its reward.",
              );
            yield* storage(() =>
              env.DB.prepare(
                `INSERT INTO pro_reward (id,userId,reportId,bug,issuer,createdAt,claimBy,state) VALUES (?,?,?,?,?,?,?,'issued')`,
              )
                .bind(
                  crypto.randomUUID(),
                  report.userId,
                  a.reportId,
                  a.bug.trim(),
                  session.user.id,
                  Date.now(),
                  Date.now() + 90 * 86400_000,
                )
                .run(),
            );
            r = yield* storage(() =>
              env.DB.prepare("SELECT * FROM pro_reward WHERE reportId=?")
                .bind(a.reportId)
                .first<Row>(),
            );
          }
          if (!r) return yield* fail("Reward could not be saved.");
          yield* claimAndDeliver(env, r);
          const updated = yield* read(env.DB, r.id);
          return json({
            reward: updated ? publicReward(updated) : null,
          });
        }),
      );
    }
    const a = yield* Schema.decodeUnknownEffect(RewardRedemption)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(invalidInput));
    if (a.accountId !== session.user.id)
      return yield* fail(
        "Your signed-in account changed. Reload and review the account before claiming.",
        409,
      );
    return yield* locked(
      env.DB,
      session.user.id,
      Effect.gen(function* () {
        const now = Date.now();
        const rate = yield* storage(() =>
          env.DB.prepare(`INSERT INTO pro_reward_attempt (userId,windowAt,attempts) VALUES (?1,?2,1)
        ON CONFLICT(userId) DO UPDATE SET attempts=CASE WHEN windowAt<=?2-3600000 THEN 1 ELSE attempts+1 END,
        windowAt=CASE WHEN windowAt<=?2-3600000 THEN ?2 ELSE windowAt END RETURNING attempts`)
            .bind(session.user.id, now)
            .first<{ attempts: number }>(),
        );
        if (!rate || rate.attempts > 10)
          return yield* fail("Too many attempts. Try again in an hour.", 429);
        const verified = yield* storage(() =>
          env.DB.prepare("SELECT id FROM user WHERE id=? AND emailVerified=1")
            .bind(session.user.id)
            .first(),
        );
        if (!verified)
          return yield* fail("Verify your email before claiming a code.", 403);
        const hash = yield* digest(a.code.trim());
        let r = yield* storage(() =>
          env.DB.prepare(
            "SELECT * FROM pro_reward WHERE codeHash=? AND (userId IS NULL OR userId=?)",
          )
            .bind(hash, session.user.id)
            .first<Row>(),
        );
        if (
          !r ||
          r.state === "revoked" ||
          (r.state === "issued" && r.claimBy <= now)
        )
          return yield* fail(
            "This code is unavailable, expired, or has already been claimed.",
          );
        if (r.userId === null) {
          const other = yield* storage(() =>
            env.DB.prepare(
              "SELECT id FROM pro_reward WHERE userId=? AND state='pending' LIMIT 1",
            )
              .bind(session.user.id)
              .first(),
          );
          if (other)
            return yield* fail(
              "Another reward is pending for this account. Resolve it first.",
            );
          const rewardId = r.id;
          const claimed = yield* storage(() =>
            env.DB.prepare(`UPDATE pro_reward SET userId=?,claimedAt=?,state='pending'
              WHERE id=? AND codeHash=? AND userId IS NULL AND claimedAt IS NULL AND state='issued' AND claimBy>? RETURNING *`)
              .bind(session.user.id, now, rewardId, hash, now)
              .first<Row>(),
          );
          if (!claimed)
            return yield* fail(
              "This code is unavailable, expired, or has already been claimed.",
            );
          r = claimed;
        }
        yield* claimAndDeliver(env, r);
        const updated = yield* read(env.DB, r.id);
        return json({ reward: updated ? publicReward(updated) : null });
      }),
    );
  },
  Effect.catchTags({
    RewardError: (e) => Effect.succeed(json({ error: e.message }, e.status)),
    RewardProviderError: () =>
      Effect.succeed(
        json(
          {
            error:
              "Billing delivery is unconfirmed. Retry the same reward safely.",
          },
          503,
        ),
      ),
    RewardStorageError: () =>
      Effect.succeed(
        json(
          {
            error:
              "Reward storage is unavailable. Retry the same reward safely.",
          },
          503,
        ),
      ),
  }),
);

const claimAndDeliver = Effect.fn("Rewards.claimAndDeliver")(function* (
  env: Env,
  r: Row,
) {
  if (r.state === "applied" || r.state === "revoked") return;
  if (!r.userId)
    return yield* fail("Claim this code before delivering its reward.");
  const other = yield* storage(() =>
    env.DB.prepare(
      "SELECT id FROM pro_reward WHERE userId=? AND id<>? AND state='pending' LIMIT 1",
    )
      .bind(r.userId, r.id)
      .first(),
  );
  if (other)
    return yield* fail(
      "Another reward is pending for this account. Resolve it first.",
    );
  if (r.state === "issued") {
    yield* storage(() =>
      env.DB.prepare(
        "UPDATE pro_reward SET state='pending',claimedAt=? WHERE id=? AND state='issued'",
      )
        .bind(Date.now(), r.id)
        .run(),
    );
    const claimed = yield* read(env.DB, r.id);
    if (!claimed) return yield* fail("Reward could not be claimed.");
    r = claimed;
  }
  yield* deliver(env, r);
});
