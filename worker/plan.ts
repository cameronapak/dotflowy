/// <reference types="@cloudflare/workers-types" />

import type { ChangeOp } from "../src/data/wire-schema";

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

/** Free tier ceiling: total LIVE nodes a free outline may hold (#152/#170).
 *  Generous by design — the funnel, not a wall; over-cap never locks (edits,
 *  moves, deletes always apply — see `batchExceedsNodeLimit`). Paid = no cap. */
export const FREE_NODE_LIMIT = 2000;

/** The node ceiling a plan enforces: free is capped, paid is unlimited (`null`,
 *  which every gate below reads as "never reject"). */
export function nodeLimitForPlan(plan: Plan): number | null {
  return plan === "free" ? FREE_NODE_LIMIT : null;
}

/**
 * The node-ceiling decision, pure so it's unit-tested (the DO supplies the three
 * counts from its SQLite; this is the rule they feed — the `resolvePlan` split).
 *
 * Would a batch that adds `inserts` genuinely-new nodes and removes `deletes`
 * existing ones, applied to an outline currently holding `before` nodes, push it
 * past `limit`? Two guarantees are baked in:
 *  - `limit === null` (paid) never rejects.
 *  - a NON-growing batch never rejects (`after <= before`), so an already
 *    over-cap outline (a downgraded user) is never locked: edits, moves, and
 *    deletes always apply, and only real growth past the ceiling is refused.
 */
export function batchExceedsNodeLimit(
  before: number,
  inserts: number,
  deletes: number,
  limit: number | null,
): boolean {
  if (limit === null) return false;
  const after = before + inserts - deletes;
  return after > limit && after > before;
}

/**
 * Net node growth a batch produces: for each DISTINCT id, its LAST op wins, and
 * a new id only counts as an insert if it ends the batch present, an existing id
 * only as a delete if it ends absent — so a delete+reinsert of the same id nets
 * zero (the DO-level twin of batchExceedsNodeLimit; keeps that pure fn's inputs
 * correct under intra-batch id churn). `exists` probes pre-batch row presence.
 *
 * Guards the cap against a `delete X, upsert X, insert Y` batch: counting deletes
 * and inserts as independent sets against pre-batch existence would credit the
 * delete of X (existed) without debiting its reinsert (still present at probe
 * time), under-counting `after` and letting a free user at the cap grow +1.
 */
export function countNetGrowth(
  ops: ReadonlyArray<ChangeOp>,
  exists: (id: string) => boolean,
): { inserts: number; deletes: number } {
  const lastIsDelete = new Map<string, boolean>();
  for (const op of ops) {
    const id = op.op === "delete" ? op.key : op.value.id;
    lastIsDelete.set(id, op.op === "delete");
  }
  let inserts = 0;
  let deletes = 0;
  for (const [id, isDelete] of lastIsDelete) {
    const existed = exists(id);
    if (!isDelete && !existed) inserts++;
    else if (isDelete && existed) deletes++;
  }
  return { inserts, deletes };
}

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
