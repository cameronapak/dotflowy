/**
 * Unit tests for the Worker auth/identity gates (ticket #232). These are the
 * security-critical decisions e2e can't reach (the mock intercepts /api/auth),
 * so this is their only coverage. See worker/identity.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  isAdminSession,
  isPlausibleEmail,
  isSignupOpen,
  matchesSharedInviteCode,
  resolveUserId,
} from "./identity";

const session = (id: string, email: string) => ({ user: { id, email } });

describe("resolveUserId (DO tenant-isolation key)", () => {
  it("routes a normal user to their own user.id, never the email", () => {
    expect(resolveUserId("user_abc", {})).toBe("user_abc");
    expect(resolveUserId("user_abc", { OWNER_USER_ID: "user_owner" })).toBe(
      "user_abc",
    );
  });

  it("collapses ONLY the exact OWNER_USER_ID to the 'default' DO", () => {
    expect(resolveUserId("user_owner", { OWNER_USER_ID: "user_owner" })).toBe(
      "default",
    );
    // A near-miss must not bridge — no prefix/substring matching.
    expect(resolveUserId("user_owner2", { OWNER_USER_ID: "user_owner" })).toBe(
      "user_owner2",
    );
  });

  it("does not bridge when OWNER_USER_ID is unset or empty", () => {
    expect(resolveUserId("default", {})).toBe("default"); // a user literally named 'default' still maps to itself
    expect(resolveUserId("user_x", { OWNER_USER_ID: "" })).toBe("user_x");
  });
});

describe("isAdminSession", () => {
  it("fails closed with no session", () => {
    expect(isAdminSession(null, { ADMIN_USER_IDS: "user_a" })).toBe(false);
    expect(isAdminSession(null, { ADMIN_EMAILS: "a@b.com" })).toBe(false);
  });

  it("fails closed when neither allowlist is set", () => {
    expect(isAdminSession(session("user_a", "a@b.com"), {})).toBe(false);
    expect(
      isAdminSession(session("user_a", "a@b.com"), {
        ADMIN_USER_IDS: "",
        ADMIN_EMAILS: "",
      }),
    ).toBe(false);
    expect(
      isAdminSession(session("user_a", "a@b.com"), {
        ADMIN_USER_IDS: "   ",
      }),
    ).toBe(false);
  });

  describe("pinned to user.id (ADMIN_USER_IDS set)", () => {
    const env = { ADMIN_USER_IDS: "user_a, user_b" };

    it("matches on the exact user.id", () => {
      expect(isAdminSession(session("user_a", "a@b.com"), env)).toBe(true);
      expect(isAdminSession(session("user_b", "anything@x.com"), env)).toBe(
        true,
      );
    });

    it("does not match a non-listed id", () => {
      expect(isAdminSession(session("user_c", "a@b.com"), env)).toBe(false);
    });

    it("ignores ADMIN_EMAILS entirely — the email path is closed", () => {
      // Even if the session's email is on the (still-set) email allowlist, a
      // non-listed user.id is NOT admin. This is the register-first fix.
      const both = {
        ADMIN_USER_IDS: "user_a",
        ADMIN_EMAILS: "attacker@b.com",
      };
      expect(isAdminSession(session("user_evil", "attacker@b.com"), both)).toBe(
        false,
      );
      expect(isAdminSession(session("user_a", "attacker@b.com"), both)).toBe(
        true,
      );
    });

    it("is case-sensitive on the id (ids are not emails)", () => {
      expect(isAdminSession(session("USER_A", "a@b.com"), env)).toBe(false);
    });
  });

  describe("legacy email fallback (only ADMIN_EMAILS set)", () => {
    const env = { ADMIN_EMAILS: "Admin@Dotflowy.com , other@x.com" };

    it("matches case-insensitively, trimming whitespace", () => {
      expect(isAdminSession(session("user_a", "admin@dotflowy.com"), env)).toBe(
        true,
      );
      expect(isAdminSession(session("user_b", "ADMIN@DOTFLOWY.COM"), env)).toBe(
        true,
      );
      expect(isAdminSession(session("user_c", "other@x.com"), env)).toBe(true);
    });

    it("does not match a non-listed email", () => {
      expect(isAdminSession(session("user_a", "nope@x.com"), env)).toBe(false);
    });
  });
});

describe("isPlausibleEmail", () => {
  it("accepts a normal address", () => {
    expect(isPlausibleEmail("a@b.com")).toBe(true);
    expect(isPlausibleEmail("first.last+tag@sub.example.co")).toBe(true);
  });

  it("rejects junk and over-long input", () => {
    expect(isPlausibleEmail("")).toBe(false);
    expect(isPlausibleEmail("no-at-sign")).toBe(false);
    expect(isPlausibleEmail("a@b")).toBe(false); // no dot in domain
    expect(isPlausibleEmail("a @b.com")).toBe(false); // whitespace
    expect(isPlausibleEmail("a@b.com ")).toBe(false); // trailing space
    expect(isPlausibleEmail(`${"a".repeat(250)}@b.com`)).toBe(false); // > 254
  });
});

describe("isSignupOpen (the SIGNUP_OPEN gate)", () => {
  it("opens ONLY on the exact string 'true'", () => {
    expect(isSignupOpen({ SIGNUP_OPEN: "true" })).toBe(true);
  });

  it("stays closed (fail-closed) when unset, empty, or any other value", () => {
    expect(isSignupOpen({})).toBe(false);
    expect(isSignupOpen({ SIGNUP_OPEN: "" })).toBe(false);
    expect(isSignupOpen({ SIGNUP_OPEN: "TRUE" })).toBe(false);
    expect(isSignupOpen({ SIGNUP_OPEN: "True" })).toBe(false);
    expect(isSignupOpen({ SIGNUP_OPEN: "1" })).toBe(false);
    expect(isSignupOpen({ SIGNUP_OPEN: "yes" })).toBe(false);
    expect(isSignupOpen({ SIGNUP_OPEN: " true " })).toBe(false);
  });
});

describe("matchesSharedInviteCode (the INVITE_CODES backdoor)", () => {
  it("denies everything when INVITE_CODES is unset, empty, or whitespace", () => {
    expect(matchesSharedInviteCode("anything", undefined)).toBe(false);
    expect(matchesSharedInviteCode("anything", "")).toBe(false);
    expect(matchesSharedInviteCode("anything", "   ")).toBe(false);
    expect(matchesSharedInviteCode("anything", " , , ")).toBe(false);
  });

  it("denies an empty supplied code even when codes exist", () => {
    expect(matchesSharedInviteCode("", "alpha,beta")).toBe(false);
  });

  it("matches an exact code, tolerating list whitespace", () => {
    expect(matchesSharedInviteCode("alpha", "alpha, beta")).toBe(true);
    expect(matchesSharedInviteCode("beta", " alpha , beta ")).toBe(true);
  });

  it("does not match an unknown code and is case-sensitive", () => {
    expect(matchesSharedInviteCode("gamma", "alpha,beta")).toBe(false);
    expect(matchesSharedInviteCode("ALPHA", "alpha,beta")).toBe(false);
  });
});
