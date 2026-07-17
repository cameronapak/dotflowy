/**
 * Pure-logic tests for the operator-restore target validation (worker/restore.ts).
 * The PITR bookmark calls themselves aren't locally testable (wrangler dev has no
 * change log), but WHERE-in-time to restore is a pure decision — exactly one of
 * time/bookmark, and a time inside the 30-day window — so it lives in the
 * `bun test` pure tier. See docs/adr/0014 for the same "validate at the boundary"
 * rationale and docs/runbooks/restore-user-pitr.md.
 */

import { describe, expect, it } from "bun:test";

import { RESTORE_WINDOW_MS, resolveRestorePoint } from "./restore";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0); // 2026-07-17T12:00:00Z

describe("resolveRestorePoint", () => {
  it("rejects when neither a time nor a bookmark is given", () => {
    const r = resolveRestorePoint({}, NOW);
    expect(r.ok).toBe(false);
  });

  it("rejects when both a time and a bookmark are given", () => {
    const r = resolveRestorePoint({ at: NOW - 1000, bookmark: "bk-abc" }, NOW);
    expect(r.ok).toBe(false);
  });

  it("accepts a raw bookmark (the undo path) verbatim", () => {
    const r = resolveRestorePoint({ bookmark: "0000abcd-book-mark" }, NOW);
    expect(r).toEqual({
      ok: true,
      point: { kind: "bookmark", bookmark: "0000abcd-book-mark" },
    });
  });

  it("rejects an empty / whitespace bookmark as absent", () => {
    expect(resolveRestorePoint({ bookmark: "" }, NOW).ok).toBe(false);
    expect(resolveRestorePoint({ bookmark: "   " }, NOW).ok).toBe(false);
  });

  it("accepts an epoch-ms number inside the window", () => {
    const at = NOW - 60 * 60 * 1000; // one hour ago
    const r = resolveRestorePoint({ at }, NOW);
    expect(r).toEqual({ ok: true, point: { kind: "time", at } });
  });

  it("accepts an ISO date string and parses it to epoch ms", () => {
    const iso = "2026-07-16T12:00:00.000Z";
    const r = resolveRestorePoint({ at: iso }, NOW);
    expect(r).toEqual({
      ok: true,
      point: { kind: "time", at: Date.parse(iso) },
    });
  });

  it("accepts an all-digits string as epoch ms", () => {
    const at = NOW - 5000;
    const r = resolveRestorePoint({ at: String(at) }, NOW);
    expect(r).toEqual({ ok: true, point: { kind: "time", at } });
  });

  it("rejects a time in the future", () => {
    const r = resolveRestorePoint({ at: NOW + 60 * 60 * 1000 }, NOW);
    expect(r.ok).toBe(false);
  });

  it("allows a small future clock skew (near-now)", () => {
    const at = NOW + 30 * 1000; // 30s ahead
    expect(resolveRestorePoint({ at }, NOW).ok).toBe(true);
  });

  it("rejects a time older than the 30-day window", () => {
    const at = NOW - RESTORE_WINDOW_MS - 60 * 1000;
    expect(resolveRestorePoint({ at }, NOW).ok).toBe(false);
  });

  it("accepts a time right at the edge of the window", () => {
    const at = NOW - RESTORE_WINDOW_MS + 60 * 1000;
    expect(resolveRestorePoint({ at }, NOW).ok).toBe(true);
  });

  it("rejects an unparseable date string", () => {
    expect(resolveRestorePoint({ at: "not a date" }, NOW).ok).toBe(false);
  });

  it("rejects a non-finite number", () => {
    expect(resolveRestorePoint({ at: Number.NaN }, NOW).ok).toBe(false);
  });
});
