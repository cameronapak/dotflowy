import { describe, expect, test } from "bun:test";

import { normalizeRetirementApiOrigin } from "../scripts/lunora-retirement";

describe("normalizeRetirementApiOrigin", () => {
  test("accepts owned HTTPS and loopback development origins", () => {
    expect(normalizeRetirementApiOrigin("https://app.dotflowy.com/")).toBe(
      "https://app.dotflowy.com",
    );
    expect(normalizeRetirementApiOrigin("https://staging.dotflowy.com")).toBe(
      "https://staging.dotflowy.com",
    );
    expect(normalizeRetirementApiOrigin("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
  });

  test("rejects external, cleartext, credentialed, and path-bearing origins", () => {
    for (const value of [
      "https://attacker.example",
      "http://app.dotflowy.com",
      "https://admin:secret@app.dotflowy.com",
      "https://app.dotflowy.com/redirect",
    ]) {
      expect(() => normalizeRetirementApiOrigin(value)).toThrow();
    }
  });
});
