/// <reference types="@cloudflare/workers-types" />
import type { Membership } from "../src/data/membership-schema";

import { resolvePlan, type Plan } from "./plan";

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

export async function readMembership(
  db: D1Database,
  userId: string,
): Promise<Membership> {
  const { results } = await db
    .prepare(
      "SELECT plan, status, cancelAtPeriodEnd FROM subscription WHERE referenceId = ?",
    )
    .bind(userId)
    .all<{ plan: string; status: string; cancelAtPeriodEnd: number | null }>();
  const plan = resolvePlan(
    results.filter(
      (row) => row.status === "active" || row.status === "trialing",
    ),
  );
  const welcome = await db
    .prepare(
      `SELECT w.id, w.plan FROM membership_welcome w
     JOIN subscription s ON s.stripeSubscriptionId = w.id AND s.referenceId = w.userId
     WHERE w.userId = ? AND w.seenAt IS NULL AND s.status = 'active'
     ORDER BY w.createdAt DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: string; plan: "unlimited" | "founding" }>();
  return {
    plan,
    legacyLeaf: hasLegacyLeaf(userId),
    subs: results.map((row) => ({
      ...row,
      cancelAtPeriodEnd: !!row.cancelAtPeriodEnd,
    })),
    welcome,
  };
}

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
