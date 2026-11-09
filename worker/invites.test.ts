import { describe, expect, it } from "bun:test";

import { generateInviteCode, inviteEmail } from "./invites";

describe("generateInviteCode", () => {
  it("generates fresh 12-character codes without ambiguous characters", () => {
    const first = generateInviteCode();
    const second = generateInviteCode();
    expect(first).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
    expect(second).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
    expect(second).not.toBe(first);
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
