import { describe, expect, it } from "bun:test";

import {
  OWNER_DO_ID,
  resolveDoName,
  shouldAbortOnStripeCancelError,
} from "./delete-account";

describe("resolveDoName", () => {
  it("routes a normal user to their own user.id", () => {
    expect(resolveDoName("user_abc")).toBe("user_abc");
    expect(resolveDoName("user_abc", "user_owner")).toBe("user_abc");
  });

  it("maps the owner to the constant 'default' DO (owner-continuity bridge)", () => {
    expect(resolveDoName("user_owner", "user_owner")).toBe(OWNER_DO_ID);
    expect(OWNER_DO_ID).toBe("default");
  });

  it("ignores an unset owner bridge", () => {
    expect(resolveDoName("user_owner", undefined)).toBe("user_owner");
    expect(resolveDoName("user_owner", "")).toBe("user_owner");
  });
});

describe("shouldAbortOnStripeCancelError", () => {
  it("does NOT abort on a 4xx invalid-request (subscription missing / already canceled — the idempotent retry case)", () => {
    expect(
      shouldAbortOnStripeCancelError({ type: "StripeInvalidRequestError" }),
    ).toBe(false);
    expect(
      shouldAbortOnStripeCancelError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
      }),
    ).toBe(false);
  });

  it("aborts on transient / unknown Stripe errors (we can't confirm the cancel — retry the whole delete)", () => {
    expect(
      shouldAbortOnStripeCancelError({ type: "StripeConnectionError" }),
    ).toBe(true);
    expect(shouldAbortOnStripeCancelError({ type: "StripeAPIError" })).toBe(
      true,
    );
  });

  it("aborts fail-safe on a non-Stripe / shapeless error", () => {
    expect(shouldAbortOnStripeCancelError(new Error("boom"))).toBe(true);
    expect(shouldAbortOnStripeCancelError(null)).toBe(true);
    expect(shouldAbortOnStripeCancelError(undefined)).toBe(true);
    expect(shouldAbortOnStripeCancelError("nope")).toBe(true);
  });
});
