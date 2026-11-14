/// <reference types="@cloudflare/workers-types" />
import { APIError } from "better-auth/api";
import { Effect, Schema } from "effect";

import type { Auth } from "./auth";

/** A trial is a deliberate, once-per-account subscription setup, not a signup
 * side effect. Incomplete abandoned Checkouts are not completed subscriptions. */
export async function isTrialEligible(db: D1Database, userId: string) {
  const row = await db
    .prepare(`
    SELECT id FROM user WHERE id = ?1 AND emailVerified = 1
    AND NOT EXISTS (SELECT 1 FROM subscription WHERE referenceId = ?1 AND (
      status IN ('active', 'trialing') OR trialStart IS NOT NULL OR trialEnd IS NOT NULL
      OR (stripeSubscriptionId IS NOT NULL AND status IN ('past_due', 'unpaid', 'incomplete', 'paused'))
    ))
    AND NOT EXISTS (SELECT 1 FROM pro_trial_checkout WHERE userId = ?1 AND usedAt IS NOT NULL)
  `)
    .bind(userId)
    .first();
  return row !== null;
}

/** Cookie-only enrollment. A persisted attempt and lease serialize app tabs;
 * the same Stripe idempotency key repairs an interrupted/lost response. */
export const trialCheckout = (
  request: Request,
  db: D1Database,
  userId: string,
  auth: Auth,
) =>
  Effect.gen(function* () {
    const json = (body: { error: string } | { url: string }, status = 200) =>
      Response.json(body, {
        status,
        headers: { "cache-control": "private, no-store" },
      });
    if (request.method !== "POST")
      return json({ error: "method not allowed" }, 405);
    if (
      !request.headers.get("content-type")?.startsWith("application/json") ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== new URL(request.url).origin)
    )
      return json({ error: "invalid origin or content type" }, 403);
    const decoded = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => null,
    }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({ consent: Schema.Literal(true) }),
        ),
      ),
      Effect.result,
    );
    if (decoded._tag === "Failure")
      return json({ error: "Confirm trial setup before continuing." }, 400);
    if (!(yield* Effect.promise(() => isTrialEligible(db, userId))))
      return json(
        {
          error:
            "This account is not eligible for another Pro trial. Check Plan & billing.",
        },
        409,
      );
    const now = Date.now();
    // One hour leaves a retry window above Stripe's 30-minute minimum.
    // Never replace an uncertain session before its fixed expiry.
    yield* Effect.promise(() =>
      db
        .prepare(`
      INSERT INTO pro_trial_checkout (userId, attemptId, createdAt, expiresAt)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(userId) DO UPDATE SET attemptId=excluded.attemptId,
        createdAt=excluded.createdAt, expiresAt=excluded.expiresAt, leaseUntil=0, url=NULL
      WHERE pro_trial_checkout.usedAt IS NULL AND pro_trial_checkout.expiresAt <= ?3
    `)
        .bind(userId, crypto.randomUUID(), now, now + 60 * 60_000)
        .run(),
    );
    const ready = yield* Effect.promise(() =>
      db
        .prepare(
          "SELECT url, expiresAt FROM pro_trial_checkout WHERE userId = ? AND usedAt IS NULL AND expiresAt > ?",
        )
        .bind(userId, now)
        .first<{ url: string | null; expiresAt: number }>(),
    );
    if (ready?.url) return json({ url: ready.url });
    if (ready && ready.expiresAt - now < 31 * 60_000)
      return json(
        {
          error: `Trial setup couldn't be confirmed. Try again in ${Math.ceil((ready.expiresAt - now) / 60_000)} minutes, after the current checkout expires.`,
        },
        409,
      );
    const claim = yield* Effect.promise(() =>
      db
        .prepare(`
      UPDATE pro_trial_checkout SET leaseUntil = ?2 WHERE userId = ?1
      AND usedAt IS NULL AND expiresAt > ?3 AND leaseUntil <= ?3
      RETURNING attemptId
    `)
        .bind(userId, now + 60_000, now)
        .first<{ attemptId: string }>(),
    );
    if (!claim)
      return json(
        { error: "Trial setup is already in progress. Try again in a moment." },
        409,
      );
    return yield* Effect.tryPromise({
      try: async () => {
        const result = await auth.api.upgradeSubscription({
          headers: request.headers,
          body: {
            plan: "unlimited",
            annual: false,
            disableRedirect: true,
            successUrl: "/settings?checkout=trial",
            cancelUrl: "/settings?checkout=canceled",
            metadata: { dotflowyTrial: claim.attemptId },
          },
        });
        if (!result.url) throw new Error("Checkout did not return a URL");
        await db
          .prepare(
            "UPDATE pro_trial_checkout SET url = ?, leaseUntil = 0 WHERE userId = ? AND attemptId = ?",
          )
          .bind(result.url, userId, claim.attemptId)
          .run();
        return json({ url: result.url });
      },
      catch: () => null,
    }).pipe(
      // Keep the lease on failure: one attempt per minute bounds provider
      // calls even when Stripe is unavailable. A retry keeps the same key.
      Effect.catch(() =>
        Effect.succeed(
          json(
            { error: "Couldn't open trial checkout. Try again in a minute." },
            503,
          ),
        ),
      ),
    );
  });

/** Only a reserved explicit enrollment gets trial days. Ordinary purchases do
 * not implicitly start a trial or silently turn a rejected trial into a charge. */
export async function trialCheckoutParams(
  db: D1Database,
  userId: string,
  attemptId: string,
) {
  const claim = await db
    .prepare(
      "SELECT expiresAt FROM pro_trial_checkout WHERE userId = ? AND attemptId = ? AND usedAt IS NULL",
    )
    .bind(userId, attemptId)
    .first<{ expiresAt: number }>();
  if (
    !claim ||
    claim.expiresAt <= Date.now() ||
    !(await isTrialEligible(db, userId))
  )
    throw new APIError("FORBIDDEN", {
      message: "This trial setup is no longer eligible. Check Plan & billing.",
    });
  return {
    params: {
      expires_at: Math.floor(claim.expiresAt / 1000),
      payment_method_collection: "if_required" as const,
      subscription_data: {
        trial_period_days: 14,
        trial_settings: {
          end_behavior: { missing_payment_method: "cancel" as const },
        },
      },
    },
    options: { idempotencyKey: `pro-trial-${userId}-${attemptId}` },
  };
}
