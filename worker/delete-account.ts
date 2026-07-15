/// <reference types="@cloudflare/workers-types" />

/**
 * Self-serve account deletion — the teardown that fans one "delete" out across
 * three transactionless systems, ordered so every reachable partial failure is
 * a SAFE one (ADR 0050). Called from Better Auth's `deleteUser` hooks in
 * worker/auth.ts: `deleteAccountData` in `beforeDelete` (a throw there aborts
 * the D1 identity delete), `scrubUserPii` in `afterDelete`.
 *
 * The order — cancel Stripe → delete the D1 subscription row → wipe the DO —
 * puts the riskiest, most-external, must-not-orphan work FIRST, so the worst
 * state (identity gone but Stripe still charging) is unreachable by
 * construction. See ADR 0050 for the full ranking + rationale.
 */

import type Stripe from "stripe";

import type { UserOutlineDO } from "./outline-do";

import { normalizeEmail } from "./invites";

/** The Durable Object name for the pre-auth / owner outline (mirrors index.ts's
 *  OWNER_DO_ID — kept here as the single source so the delete path and the
 *  request router can't drift on which DO holds a given user's data). */
export const OWNER_DO_ID = "default";

/**
 * The DO name for a user's outline. Permanent-by-`user.id` (ADR 0011), except
 * the owner-continuity bridge: when `ownerUserId` is set and matches, the owner
 * maps to the constant OWNER_DO_ID where their pre-auth outline lives. Pure so
 * both the request router (index.ts) and the delete teardown resolve the SAME
 * DO — deleting must wipe exactly the DO the app reads/writes.
 */
export function resolveDoName(userId: string, ownerUserId?: string): string {
  return ownerUserId && userId === ownerUserId ? OWNER_DO_ID : userId;
}

/**
 * Whether a Stripe cancel error should ABORT the whole delete (rethrow) or be
 * treated as an idempotent no-op (swallow). The discriminator is Stripe's error
 * `type`: a `StripeInvalidRequestError` is a 4xx — the subscription is missing
 * or already canceled (exactly the state a retry after a partial failure lands
 * in), so there is nothing left to cancel and the delete may proceed. Anything
 * else (connection/API/5xx — "we don't know if it canceled") aborts, so the
 * delete is retried rather than risk leaving a live subscription behind. Pure,
 * so it's unit-tested without a Stripe client.
 */
export function shouldAbortOnStripeCancelError(err: unknown): boolean {
  const type = (err as { type?: string } | null)?.type;
  return type !== "StripeInvalidRequestError";
}

/** Idempotent immediate cancel of one subscription. Immediate (not
 *  `cancel_at_period_end`): a subscription living on past a deleted user is the
 *  orphan the ordering exists to prevent. */
async function cancelSubscription(
  stripe: Stripe,
  subscriptionId: string,
): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (err) {
    if (shouldAbortOnStripeCancelError(err)) throw err;
    // Missing / already-canceled: a retry landing on an already-torn-down
    // subscription. Nothing to do; let the delete proceed.
    console.warn(
      `stripe cancel no-op (${subscriptionId}): already canceled or missing`,
    );
  }
}

export interface DeleteAccountDeps {
  db: D1Database;
  stripe: Stripe;
  userOutline: DurableObjectNamespace<UserOutlineDO>;
  /** env.OWNER_USER_ID — the owner-continuity bridge (usually unset). */
  ownerUserId?: string;
}

/**
 * beforeDelete: tear down everything Better Auth's D1 cascade does NOT own,
 * in the safe order. Throwing here aborts the identity delete (Better Auth's
 * contract), so a failure leaves the account fully intact and retryable.
 *
 * Every step is idempotent: a retry after a partial failure re-runs and no-ops
 * whatever already happened (already-canceled Stripe sub → swallowed; the D1
 * row is already gone → DELETE matches nothing; purge() on an empty DO is a
 * no-op).
 */
export async function deleteAccountData(
  deps: DeleteAccountDeps,
  userId: string,
): Promise<void> {
  // 1. Cancel live Stripe subscriptions FIRST (external + riskiest + must not
  //    outlive the account). Comped rows carry no stripeSubscriptionId, so they
  //    are skipped here and removed by step 2.
  const subs = await deps.db
    .prepare(
      `SELECT stripeSubscriptionId FROM subscription
       WHERE referenceId = ?1
         AND status IN ('active', 'trialing')
         AND stripeSubscriptionId IS NOT NULL`,
    )
    .bind(userId)
    .all<{ stripeSubscriptionId: string }>();
  for (const { stripeSubscriptionId } of subs.results) {
    await cancelSubscription(deps.stripe, stripeSubscriptionId);
  }

  // 2. Remove the D1 subscription rows (Better Auth's deleteUser does NOT
  //    cascade the Stripe plugin's table). Covers comped rows too.
  await deps.db
    .prepare(`DELETE FROM subscription WHERE referenceId = ?1`)
    .bind(userId)
    .run();

  // 3. Wipe the outline DO (its private SQLite + kv side-collections, atomic —
  //    ADR 0050). LAST, so a failure here leaves the account intact rather than
  //    orphaning live data under a deleted identity. 30-day PITR still holds an
  //    operator-recoverable backup; see ADR 0050.
  const doName = resolveDoName(userId, deps.ownerUserId);
  const stub = deps.userOutline.get(deps.userOutline.idFromName(doName));
  await stub.purge();
}

/**
 * afterDelete: best-effort scrub of the email-bearing side tables Better Auth
 * doesn't know about — the `waitlist` and per-email `invites` rows (both keyed
 * on the normalized email). Runs AFTER the identity is already deleted, so a
 * failure here must NOT throw (the account is gone; there is nothing to roll
 * back) — log and move on. Uses `normalizeEmail` (the same normalization both
 * tables store under) so the DELETE actually matches.
 */
export async function scrubUserPii(
  deps: Pick<DeleteAccountDeps, "db">,
  email: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  try {
    await deps.db.batch([
      deps.db.prepare(`DELETE FROM waitlist WHERE email = ?1`).bind(normalized),
      deps.db.prepare(`DELETE FROM invites WHERE email = ?1`).bind(normalized),
    ]);
  } catch (err) {
    console.error(`account PII scrub failed (post-delete, non-fatal):`, err);
  }
}
