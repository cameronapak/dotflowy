import { describe, expect, test } from "bun:test";

import { cancelActiveSubscriptions, isOwnerAccount } from "./account-deletion";

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

  test("Stripe key set but no active rows = no Stripe client constructed", async () => {
    // With a key present we query D1; an empty result set must return before
    // constructing a Stripe client (which would fire real network calls).
    const emptyDb = {
      prepare() {
        return {
          bind() {
            return {
              all() {
                return Promise.resolve({ results: [] });
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
  });
});
