import { describe, expect, test } from "bun:test";

import {
  cancelActiveSubscriptions,
  deleteResidualUserRows,
  isOwnerAccount,
} from "./account-deletion";

// Pure logic only (the repo's unit-test rule). The owner guard is the load-
// bearing safety check — refusing self-serve deletion of the OWNER_USER_ID
// account, which maps to the shared 'default' DO (docs/adr/0051). The Stripe
// skip-in-dev branch is the other worker-reachable decision; the live Stripe
// path is exercised by hand (no D1/Stripe in bun test).
test("isOwnerAccount matches only the exact, configured OWNER_USER_ID", () => {
  expect(isOwnerAccount("owner-123", "owner-123")).toBe(true);
  expect(isOwnerAccount("user-abc", "owner-123")).toBe(false);
  // No owner configured means no account is the owner, including an empty id
  // against an empty env var.
  expect(isOwnerAccount("user-abc", undefined)).toBe(false);
  expect(isOwnerAccount("", undefined)).toBe(false);
  expect(isOwnerAccount("", "")).toBe(false);
});

/** A D1 stub that records every prepared statement + its bindings. `all()`
 *  returns empty results and `first()` a null customer id, so no Stripe client
 *  is ever constructed (which would fire real network calls). */
function recordingDb(calls: Array<{ sql: string; args: unknown[] }>) {
  // SAFETY: the object below implements the D1 surface these tests exercise (prepare/bind/all/first/run/batch) and nothing else; the single assertion stamps it as D1Database for the env.
  return Object.assign({} as D1Database, {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          calls.push({ sql, args });
          return {
            all: () => Promise.resolve({ results: [] }),
            first: () => Promise.resolve({ stripeCustomerId: null }),
            run: () => Promise.resolve({}),
          };
        },
      };
    },
    batch: (stmts: unknown[]) => Promise.resolve(stmts.map(() => ({}))),
  });
}

describe("cancelActiveSubscriptions", () => {
  test("no STRIPE_SECRET_KEY = skip Stripe but STILL clear the D1 subscription row", async () => {
    // The row delete is unconditional (a comped user is an operator-inserted
    // active row with NO Stripe ids; dev has no key at all) — only the Stripe
    // API half is gated on the key. ADR 0051: the row is cleared in
    // beforeDelete, not the best-effort afterDelete sweep.
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    await cancelActiveSubscriptions({ DB: recordingDb(calls) }, "user-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("DELETE FROM subscription");
    expect(calls[0]!.args).toEqual(["user-abc"]);
  });

  test("Stripe key set: sweeps every non-terminal status, reads the customer id, and clears the row last", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    await cancelActiveSubscriptions(
      { DB: recordingDb(calls), STRIPE_SECRET_KEY: "sk_test_x" },
      "user-abc",
    );
    const subQuery = calls.find((c) =>
      c.sql.includes("SELECT stripeSubscriptionId"),
    );
    // Deletion asks "could Stripe ever charge again?", NOT "is this user paid
    // up?" (plan.ts's 'active'/'trialing'). A past_due sub mid-dunning, or an
    // unpaid/incomplete/paused one, grants no entitlement but can still charge
    // later, so the query sweeps it too. Terminal states have nothing to cancel.
    for (const status of [
      "active",
      "incomplete",
      "past_due",
      "paused",
      "trialing",
      "unpaid",
    ]) {
      expect(subQuery!.sql).toContain(`'${status}'`);
    }
    expect(subQuery!.sql).not.toContain("'canceled'");
    expect(subQuery!.sql).not.toContain("'incomplete_expired'");
    // The customer lookup reads the plugin's column on the user row.
    expect(calls.some((c) => c.sql.includes("stripeCustomerId"))).toBe(true);
    // And the D1 row is cleared last (after Stripe committed / was skipped).
    expect(calls[calls.length - 1]!.sql).toContain("DELETE FROM subscription");
  });
});

describe("deleteResidualUserRows", () => {
  test("scrubs OAuth by userId and waitlist + invites by NORMALIZED email; subscription is NOT here", async () => {
    // The subscription row is the entitlement record — too load-bearing for a
    // best-effort sweep, so it's cleared in beforeDelete's Stripe step (ADR
    // 0051) and must NOT reappear here. The email-keyed waitlist (0005) and
    // invites (0007) rows must be deleted under the same trim+lowercase their
    // inserts used (normalizeEmail, worker/invites.ts).
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    // SAFETY: the object below implements the D1 surface deleteResidualUserRows exercises (prepare/bind/batch) and nothing else; the single assertion stamps it as D1Database for the call.
    const db = Object.assign({} as D1Database, {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            calls.push({ sql, args });
            return {};
          },
        };
      },
      batch(stmts: unknown[]) {
        return Promise.resolve(stmts.map(() => ({})));
      },
    });

    await deleteResidualUserRows(db, "user-abc", "  User@Example.COM ");

    const bySql = (frag: string) => calls.find((c) => c.sql.includes(frag));
    expect(bySql("oauthAccessToken")!.args).toEqual(["user-abc"]);
    expect(bySql("oauthConsent")!.args).toEqual(["user-abc"]);
    expect(bySql("oauthApplication")!.args).toEqual(["user-abc"]);
    expect(bySql("DELETE FROM waitlist")!.args).toEqual(["user@example.com"]);
    expect(bySql("DELETE FROM invites")!.args).toEqual(["user@example.com"]);
    expect(bySql("subscription")).toBeUndefined();
  });
});
