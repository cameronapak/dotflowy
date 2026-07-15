/// <reference types="@cloudflare/workers-types" />

/**
 * Self-serve account deletion (ticket #224 / docs/adr/0051). The lifecycle
 * WIRING lives in worker/auth.ts's `user.deleteUser` hooks; the owner guard and
 * the Stripe teardown are factored HERE so the guard is unit-testable without a
 * live auth stack and auth.ts stays declarative.
 */

import Stripe from "stripe";

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
 * Cancel every active/trialing Stripe subscription attached to this user
 * IMMEDIATELY, BEFORE the account rows vanish. Immediate cancellation (not
 * `cancel_at_period_end`): there is no account left to keep billing against, and
 * a deletion is not a refund request — the founding prepay forfeits its
 * remaining term, which is the user's own choice in deleting the account.
 *
 * THROWS on any real Stripe failure so the caller aborts the WHOLE deletion — a
 * paying subscription must never outlive the account it was attached to (that
 * would keep billing a user who can no longer sign in). An already-cancelled /
 * missing subscription is treated as success (goal achieved). In dev
 * (no STRIPE_SECRET_KEY) there are no real subscriptions, so this is a clean
 * no-op skip.
 */
export async function cancelActiveSubscriptions(
  env: StripeCancelEnv,
  userId: string,
): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return;
  const { results } = await env.DB.prepare(
    `SELECT stripeSubscriptionId FROM subscription
       WHERE referenceId = ?1 AND status IN ('active', 'trialing')
       AND stripeSubscriptionId IS NOT NULL`,
  )
    .bind(userId)
    .all<{ stripeSubscriptionId: string }>();
  if (!results.length) return;

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  for (const { stripeSubscriptionId } of results) {
    try {
      await stripe.subscriptions.cancel(stripeSubscriptionId);
    } catch (err) {
      if (isAlreadyCancelled(err)) continue;
      throw err;
    }
  }
}

/**
 * Remove the D1 rows Better Auth's core `deleteUser` does NOT itself remove.
 * Core deletes `user`/`session`/`account`/`verification`; these are the plugin
 * and generated tables keyed on the deleted user:
 *
 * - `subscription` (@better-auth/stripe, migration 0006) has NO foreign key on
 *   `referenceId`, so it would ORPHAN without this — the one row we MUST delete.
 * - the mcp OAuth tables (migration 0004) DO declare `ON DELETE CASCADE`, so
 *   they may already be gone; deleting them by `userId` is idempotent and makes
 *   cleanup correct whether or not D1 enforced the cascade.
 *
 * Best-effort by design: it runs in `afterDelete`, when the identity rows are
 * already gone, so any leftover here is unreachable (nothing routes to a
 * deleted `user.id`) — never a reason to fail a deletion that already happened.
 */
export function deleteResidualUserRows(
  db: D1Database,
  userId: string,
): Promise<D1Result[]> {
  return db.batch([
    db.prepare("DELETE FROM subscription WHERE referenceId = ?").bind(userId),
    db.prepare("DELETE FROM oauthAccessToken WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM oauthConsent WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM oauthApplication WHERE userId = ?").bind(userId),
  ]);
}
