/// <reference types="@cloudflare/workers-types" />

/**
 * Self-serve account deletion (ticket #224 / docs/adr/0051). The lifecycle
 * WIRING lives in worker/auth.ts's `user.deleteUser` hooks; the owner guard and
 * the Stripe teardown are factored HERE so the guard is unit-testable without a
 * live auth stack and auth.ts stays declarative.
 */

import Stripe from "stripe";

import { normalizeEmail } from "./invites";

/**
 * The owner-continuity account (OWNER_USER_ID) maps to the constant 'default'
 * Durable Object (worker/index.ts `resolveUserId`) — where the pre-auth outline
 * lives. Self-serve deletion is REFUSED for it: wiping 'default' would erase
 * shared pre-auth data and is an operator decision, not a button press. Pure so
 * the refusal is unit-tested directly (worker/account-deletion.test.ts).
 */
export function isOwnerAccount(
  userId: string,
  ownerUserId: string | undefined,
): boolean {
  return !!ownerUserId && userId === ownerUserId;
}

/** Is this a Stripe "the subscription is already gone / already cancelled"
 *  error? Cancelling a subscription that Stripe no longer has active is our
 *  GOAL, not a failure — so it must not abort the account deletion. Everything
 *  else (auth error, network, rate limit) is a real failure and rethrows. */
function isAlreadyCancelled(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "resource_missing" ||
    /already been canceled|already canceled|no such subscription/i.test(
      e?.message ?? "",
    )
  );
}

interface StripeCancelEnv {
  DB: D1Database;
  STRIPE_SECRET_KEY?: string;
}

/**
 * Every subscription status that can still bill in the future. DELIBERATELY
 * WIDER than worker/plan.ts's entitlement gate ('active','trialing') — those
 * answer DIFFERENT questions: entitlement asks "is this user paid up right
 * now?", deletion asks "could Stripe ever charge this user again?". A
 * `past_due` sub mid-dunning (or an `unpaid`/`incomplete`/`paused` one) grants
 * nothing but can still successfully charge later — deletion must kill it too.
 * Don't "unify" this list with plan.ts's. Exported for the unit test.
 */
export const BILLABLE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
] as const;

/**
 * Stop ALL future Stripe billing for this user and erase their Stripe-side
 * identity, BEFORE the account rows vanish: cancel every still-billable
 * subscription IMMEDIATELY (not `cancel_at_period_end` — there is no account
 * left to keep billing against, and a deletion is not a refund request; the
 * founding prepay forfeits its remaining term, which is the user's own choice
 * in deleting the account), then DELETE the Stripe Customer object, which (a)
 * removes the user's email + payment metadata from Stripe (privacy erasure —
 * the account deletion promise extends to the processor) and (b) hard-stops
 * anything a missed subscription row could still bill.
 *
 * THROWS on any real Stripe failure so the caller aborts the WHOLE deletion — a
 * paying subscription must never outlive the account it was attached to (that
 * would keep billing a user who can no longer sign in). An already-cancelled /
 * missing subscription or customer is treated as success (goal achieved). In
 * dev (no STRIPE_SECRET_KEY) there is no Stripe state, so the Stripe half is a
 * clean skip.
 *
 * The D1 `subscription` rows are then deleted HERE, in beforeDelete — not in
 * the best-effort afterDelete sweep (ADR 0051, the grilled ordering): Better
 * Auth's `deleteUser` does not cascade the Stripe plugin's table, and a failed
 * afterDelete would orphan the row. This runs UNCONDITIONALLY (no Stripe key
 * needed): a comped user is an operator-inserted `active` row with NO Stripe
 * ids (#170), and a free user has no row — both skip the Stripe call and just
 * clear D1. Idempotent: deleting an absent row is a no-op, so a retry after a
 * partial failure is safe.
 */
export async function cancelActiveSubscriptions(
  env: StripeCancelEnv,
  userId: string,
): Promise<void> {
  if (env.STRIPE_SECRET_KEY) {
    const statuses = BILLABLE_SUBSCRIPTION_STATUSES.map((s) => `'${s}'`).join(
      ", ",
    );
    const [{ results }, customerRow] = await Promise.all([
      env.DB.prepare(
        `SELECT stripeSubscriptionId FROM subscription
           WHERE referenceId = ?1 AND status IN (${statuses})
           AND stripeSubscriptionId IS NOT NULL`,
      )
        .bind(userId)
        .all<{ stripeSubscriptionId: string }>(),
      // The @better-auth/stripe plugin stores the customer mapping on the user
      // row (migration 0006's `user.stripeCustomerId`); no row value = the user
      // never reached checkout, so there is nothing at Stripe to erase.
      env.DB.prepare(`SELECT stripeCustomerId FROM user WHERE id = ?1`)
        .bind(userId)
        .first<{ stripeCustomerId: string | null }>(),
    ]);
    const customerId = customerRow?.stripeCustomerId ?? null;

    if (results.length || customerId) {
      const stripe = new Stripe(env.STRIPE_SECRET_KEY);
      for (const { stripeSubscriptionId } of results) {
        try {
          await stripe.subscriptions.cancel(stripeSubscriptionId);
        } catch (err) {
          if (isAlreadyCancelled(err)) continue;
          throw err;
        }
      }
      if (customerId) {
        try {
          // Deleting the customer also cancels any subscription still attached
          // to it, so this doubly guarantees "no future billing".
          await stripe.customers.del(customerId);
        } catch (err) {
          if (!isAlreadyCancelled(err)) throw err; // already gone = goal met
        }
      }
    }
  }
  // Only after Stripe has committed (or was rightly skipped) does the D1 row
  // go — the row is the entitlement record, and clearing it before a failed
  // cancel would hide a still-live subscription from the retry.
  await env.DB.prepare(`DELETE FROM subscription WHERE referenceId = ?1`)
    .bind(userId)
    .run();
}

/**
 * Remove the D1 rows Better Auth's core `deleteUser` does NOT itself remove.
 * Core deletes `user`/`session`/`account`/`verification`; the `subscription`
 * row is already gone (cleared in beforeDelete's Stripe step — it's the
 * entitlement record, too load-bearing for a best-effort sweep). What's left:
 *
 * - the mcp OAuth tables (migration 0004) DO declare `ON DELETE CASCADE`, so
 *   they may already be gone; deleting them by `userId` is idempotent and makes
 *   cleanup correct whether or not D1 enforced the cascade.
 * - the `waitlist` row (migration 0005) and the `invites` row (migration 0007)
 *   are keyed on the EMAIL, not a user id — a user who joined the waitlist or
 *   was invited still has one, both carry PII (the address), and "delete my
 *   account" is a privacy-erasure promise that covers them. Deleted under the
 *   SAME normalization their inserts used (`normalizeEmail`, worker/invites.ts
 *   — the waitlist insert in worker/index.ts applies the identical
 *   trim+lowercase).
 *
 * Best-effort by design: it runs in `afterDelete`, when the identity rows are
 * already gone, so any leftover here is unreachable (nothing routes to a
 * deleted `user.id`) — never a reason to fail a deletion that already happened.
 */
export function deleteResidualUserRows(
  db: D1Database,
  userId: string,
  email: string,
): Promise<D1Result[]> {
  const normalized = normalizeEmail(email);
  return db.batch([
    db.prepare("DELETE FROM oauthAccessToken WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM oauthConsent WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM oauthApplication WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM waitlist WHERE email = ?").bind(normalized),
    db.prepare("DELETE FROM invites WHERE email = ?").bind(normalized),
  ]);
}
