/**
 * Unit tests for the Worker auth/identity gates (ticket #232). These are the
 * security-critical decisions e2e can't reach (the mock intercepts /api/auth),
 * so this is their only coverage. See worker/identity.ts.
 */

import { expect, test } from "bun:test";

import {
  isAdminSession,
  isPlausibleEmail,
  isSignupOpen,
  matchesSharedInviteCode,
  resolveUserId,
} from "./identity";

const session = (id: string, email: string) => ({ user: { id, email } });

test("resolveUserId keys each user's DO by user.id and bridges ONLY the exact OWNER_USER_ID to 'default'", () => {
  expect(resolveUserId("user_abc", {})).toBe("user_abc");
  expect(resolveUserId("user_abc", { OWNER_USER_ID: "user_owner" })).toBe(
    "user_abc",
  );
  expect(resolveUserId("user_owner", { OWNER_USER_ID: "user_owner" })).toBe(
    "default",
  );
  // A near-miss must not bridge: no prefix or substring matching.
  expect(resolveUserId("user_owner2", { OWNER_USER_ID: "user_owner" })).toBe(
    "user_owner2",
  );
  // Unset or empty OWNER_USER_ID never bridges.
  expect(resolveUserId("default", {})).toBe("default");
  expect(resolveUserId("user_x", { OWNER_USER_ID: "" })).toBe("user_x");
});

test("isAdminSession fails closed with no session or no allowlist", () => {
  expect(isAdminSession(null, { ADMIN_USER_IDS: "user_a" })).toBe(false);
  expect(isAdminSession(null, { ADMIN_EMAILS: "a@b.com" })).toBe(false);
  const user = session("user_a", "a@b.com");
  expect(isAdminSession(user, {})).toBe(false);
  expect(isAdminSession(user, { ADMIN_USER_IDS: "", ADMIN_EMAILS: "" })).toBe(
    false,
  );
  expect(isAdminSession(user, { ADMIN_USER_IDS: "   " })).toBe(false);
});

test("isAdminSession pins to the exact, case-sensitive user.id when ADMIN_USER_IDS is set, ignoring ADMIN_EMAILS", () => {
  const env = { ADMIN_USER_IDS: "user_a, user_b" };
  expect(isAdminSession(session("user_a", "a@b.com"), env)).toBe(true);
  expect(isAdminSession(session("user_b", "anything@x.com"), env)).toBe(true);
  expect(isAdminSession(session("user_c", "a@b.com"), env)).toBe(false);
  expect(isAdminSession(session("USER_A", "a@b.com"), env)).toBe(false);
  // Register-first fix: an email on the still-set email allowlist does not make
  // a non-listed user.id admin.
  const both = { ADMIN_USER_IDS: "user_a", ADMIN_EMAILS: "attacker@b.com" };
  expect(isAdminSession(session("user_evil", "attacker@b.com"), both)).toBe(
    false,
  );
  expect(isAdminSession(session("user_a", "attacker@b.com"), both)).toBe(true);
});

test("isAdminSession falls back to a trimmed, case-insensitive email match when only ADMIN_EMAILS is set", () => {
  const env = { ADMIN_EMAILS: "Admin@Dotflowy.com , other@x.com" };
  expect(isAdminSession(session("user_a", "admin@dotflowy.com"), env)).toBe(
    true,
  );
  expect(isAdminSession(session("user_b", "ADMIN@DOTFLOWY.COM"), env)).toBe(
    true,
  );
  expect(isAdminSession(session("user_c", "other@x.com"), env)).toBe(true);
  expect(isAdminSession(session("user_a", "nope@x.com"), env)).toBe(false);
});

test.each([
  ["a@b.com", true],
  ["first.last+tag@sub.example.co", true],
  ["", false],
  ["no-at-sign", false],
  ["a@b", false], // no dot in domain
  ["a @b.com", false], // whitespace
  ["a@b.com ", false], // trailing space
  [`${"a".repeat(250)}@b.com`, false], // over 254 chars
])("isPlausibleEmail(%p) is %p", (email, ok) => {
  expect(isPlausibleEmail(email)).toBe(ok);
});

test("isSignupOpen opens ONLY on the exact string 'true' and fails closed otherwise", () => {
  expect(isSignupOpen({ SIGNUP_OPEN: "true" })).toBe(true);
  expect(isSignupOpen({})).toBe(false);
  for (const value of ["", "TRUE", "True", "1", "yes", " true "])
    expect(isSignupOpen({ SIGNUP_OPEN: value })).toBe(false);
});

test("matchesSharedInviteCode matches an exact, case-sensitive listed code and denies everything else", () => {
  // Unset, empty, or whitespace-only INVITE_CODES denies every code.
  for (const codes of [undefined, "", "   ", " , , "])
    expect(matchesSharedInviteCode("anything", codes)).toBe(false);
  expect(matchesSharedInviteCode("", "alpha,beta")).toBe(false);
  // List whitespace is tolerated.
  expect(matchesSharedInviteCode("alpha", "alpha, beta")).toBe(true);
  expect(matchesSharedInviteCode("beta", " alpha , beta ")).toBe(true);
  expect(matchesSharedInviteCode("gamma", "alpha,beta")).toBe(false);
  expect(matchesSharedInviteCode("ALPHA", "alpha,beta")).toBe(false);
});
