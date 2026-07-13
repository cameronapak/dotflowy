/// <reference types="@cloudflare/workers-types" />

/**
 * Plan resolution: the ONE read the entitlement checks consume. Subscription
 * state lives in D1 in the @better-auth/stripe plugin's `subscription` table
 * (migration 0006), maintained by Stripe webhooks — nothing here (or anywhere
 * on the request path) calls Stripe. See issue #162's resolution.
 *
 * The free tier is the absence of an active subscription row, so a user with
 * no row — every alpha account today — is `free` with zero backfill.
 */

export type Plan = "free" | "unlimited" | "founding";

/** Plan names as stored by the plugin (it lowercases `plan` on write). */
export const PAID_PLANS = ["unlimited", "founding"] as const;

/** Founding is capped at 50 seats, app-enforced (Stripe has no price-level
 *  inventory cap). Enforced at checkout creation in worker/auth.ts. */
export const FOUNDING_SEAT_LIMIT = 50;

/** Pure half of getPlan: pick the plan from the user's entitled subscription
 *  rows. Founding outranks unlimited if a user somehow holds both. Unknown
 *  plan names grant nothing (fail closed). */
export function resolvePlan(rows: ReadonlyArray<{ plan: string }>): Plan {
  let plan: Plan = "free";
  for (const row of rows) {
    if (row.plan === "founding") return "founding";
    if (row.plan === "unlimited") plan = "unlimited";
  }
  return plan;
}

/**
 * The caller's plan, from one D1 query. `referenceId` is the Better Auth
 * `user.id` (the plugin sets this by construction — never the email; the DO
 * routing key rule extends to billing). An operator-comped user is a manually
 * inserted row (`plan`, `referenceId`, `status: 'active'`, no Stripe ids) —
 * this read treats it identically to a paid one (#170 owns the mechanism).
 * Webhooks keep `status` current, so `active`/`trialing` alone is the gate —
 * no period-end math here.
 */
export async function getPlan(
  userId: string,
  env: { DB: D1Database },
): Promise<Plan> {
  const result = await env.DB.prepare(
    `SELECT plan FROM subscription WHERE referenceId = ?1 AND status IN ('active', 'trialing')`,
  )
    .bind(userId)
    .all<{ plan: string }>();
  return resolvePlan(result.results);
}

/** Active founding seats, for the 50-seat checkout gate and the pricing
 *  surface's "seats left" display (#171). */
export async function countFoundingSeats(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM subscription WHERE plan = 'founding' AND status IN ('active', 'trialing')`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}
