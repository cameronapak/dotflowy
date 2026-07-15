import { describe, expect, test } from "bun:test";

import {
  BILLABLE_SUBSCRIPTION_STATUSES,
  cancelActiveSubscriptions,
  isOwnerAccount,
  normalizeWaitlistEmail,
} from "./account-deletion";

// Pure logic only (the repo's unit-test rule). The owner guard is the load-
// bearing safety check — refusing self-serve deletion of the OWNER_USER_ID
// account, which maps to the shared 'default' DO (docs/adr/0051). The Stripe
// skip-in-dev branch is the other worker-reachable decision; the live Stripe
// path is exercised by hand (no D1/Stripe in bun test).
describe("isOwnerAccount", () => {
  test("true when the id matches OWNER_USER_ID", () => {
    expect(isOwnerAccount("owner-123", "owner-123")).toBe(true);
  });

  test("false for any other account", () => {
    expect(isOwnerAccount("user-abc", "owner-123")).toBe(false);
  });

  test("false when OWNER_USER_ID is unset (no owner bridge configured)", () => {
    expect(isOwnerAccount("user-abc", undefined)).toBe(false);
    // The empty-string env-var case must not accidentally match an id that is
    // itself empty — no owner configured means no account is the owner.
    expect(isOwnerAccount("", undefined)).toBe(false);
    expect(isOwnerAccount("", "")).toBe(false);
  });
});

describe("BILLABLE_SUBSCRIPTION_STATUSES", () => {
  test("covers every non-terminal billing state, wider than plan.ts entitlement", () => {
    // Deletion asks "could Stripe ever charge again?", NOT "is this user paid
    // up?" (plan.ts's 'active'/'trialing'). A past_due sub mid-dunning — or an
    // unpaid/incomplete/paused one — grants no entitlement but can still
    // successfully charge later, so deletion must sweep it too.
    expect(([...BILLABLE_SUBSCRIPTION_STATUSES] as string[]).sort()).toEqual(
      [
        "active",
        "incomplete",
        "past_due",
        "paused",
        "trialing",
        "unpaid",
      ].sort(),
    );
  });

  test("excludes the terminal states (nothing left to cancel)", () => {
    const statuses: readonly string[] = BILLABLE_SUBSCRIPTION_STATUSES;
    expect(statuses).not.toContain("canceled");
    expect(statuses).not.toContain("incomplete_expired");
  });
});

describe("normalizeWaitlistEmail", () => {
  test("matches the waitlist insert's normalization (trim + lowercase)", () => {
    // Must stay in lockstep with worker/index.ts handleWaitlist, or the
    // afterDelete waitlist purge misses the row the signup-era insert created.
    expect(normalizeWaitlistEmail("  User@Example.COM ")).toBe(
      "user@example.com",
    );
    expect(normalizeWaitlistEmail("plain@x.dev")).toBe("plain@x.dev");
  });
});

describe("cancelActiveSubscriptions", () => {
  test("no STRIPE_SECRET_KEY = clean no-op, never touches D1", async () => {
    // A DB whose every call throws proves the guard short-circuits before any
    // query (dev has no Stripe key and no real subscriptions).
    const throwingDb = {
      prepare() {
        throw new Error("DB should not be touched without a Stripe key");
      },
    } as unknown as D1Database;
    await expect(
      cancelActiveSubscriptions({ DB: throwingDb }, "user-abc"),
    ).resolves.toBeUndefined();
  });

  test("Stripe key set, no billable rows, no customer id = no Stripe client", async () => {
    // With a key present we query D1; empty subscription results AND a null
    // stripeCustomerId must return before constructing a Stripe client (which
    // would fire real network calls). Also asserts the widened status list is
    // what the subscription query filters on.
    const queries: string[] = [];
    const emptyDb = {
      prepare(sql: string) {
        queries.push(sql);
        return {
          bind() {
            return {
              all() {
                return Promise.resolve({ results: [] });
              },
              first() {
                return Promise.resolve({ stripeCustomerId: null });
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(
      cancelActiveSubscriptions(
        { DB: emptyDb, STRIPE_SECRET_KEY: "sk_test_x" },
        "user-abc",
      ),
    ).resolves.toBeUndefined();
    const subQuery = queries.find((q) => q.includes("FROM subscription"));
    expect(subQuery).toBeDefined();
    for (const status of BILLABLE_SUBSCRIPTION_STATUSES) {
      expect(subQuery).toContain(`'${status}'`);
    }
    // And the customer lookup reads the plugin's column on the user row.
    expect(queries.some((q) => q.includes("stripeCustomerId"))).toBe(true);
  });
});
