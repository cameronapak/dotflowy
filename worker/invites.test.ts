import { describe, expect, it } from "bun:test";

import { generateInviteCode, inviteEmail, normalizeEmail } from "./invites";

describe("generateInviteCode", () => {
  it("is 12 unambiguous chars — no 0/O/1/I/L", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
    }
  });

  it("does not collide across a batch", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateInviteCode());
    expect(seen.size).toBe(1000);
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases so mint- and redeem-time comparisons match", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(normalizeEmail("a@b.com")).toBe("a@b.com");
  });
});

describe("inviteEmail", () => {
  it("carries the code, signup url, and bound address in both bodies", () => {
    const msg = inviteEmail(
      "ABCD23456789",
      "https://app.dotflowy.com/",
      "a@b.com",
    );
    for (const body of [msg.text, msg.html]) {
      expect(body).toContain("ABCD23456789");
      expect(body).toContain("https://app.dotflowy.com/");
      expect(body).toContain("a@b.com");
    }
    expect(msg.subject.length).toBeGreaterThan(0);
  });
});
