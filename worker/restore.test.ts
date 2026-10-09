/**
 * Pure-logic tests for the operator-restore target validation (worker/restore.ts).
 * The PITR bookmark calls themselves aren't locally testable (wrangler dev has no
 * change log), but WHERE-in-time to restore is a pure decision — exactly one of
 * time/bookmark, and a time inside the 30-day window — so it lives in the
 * `bun test` pure tier. See docs/adr/0014 for the same "validate at the boundary"
 * rationale and docs/runbooks/restore-user-pitr.md.
 */

import { expect, test } from "bun:test";

import { resolveRestorePoint } from "./restore";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0); // 2026-07-17T12:00:00Z
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

test("resolveRestorePoint accepts a bookmark or an in-window time in any accepted spelling", () => {
  // A raw bookmark (the undo path) passes through verbatim.
  expect(resolveRestorePoint({ bookmark: "0000abcd-book-mark" }, NOW)).toEqual({
    ok: true,
    point: { kind: "bookmark", bookmark: "0000abcd-book-mark" },
  });
  // Epoch ms, an ISO string, and an all-digits string all resolve to epoch ms.
  const hourAgo = NOW - 60 * MINUTE_MS;
  expect(resolveRestorePoint({ at: hourAgo }, NOW)).toEqual({
    ok: true,
    point: { kind: "time", at: hourAgo },
  });
  expect(resolveRestorePoint({ at: "2026-07-16T12:00:00.000Z" }, NOW)).toEqual({
    ok: true,
    point: { kind: "time", at: NOW - DAY_MS },
  });
  expect(resolveRestorePoint({ at: String(NOW - 5000) }, NOW)).toEqual({
    ok: true,
    point: { kind: "time", at: NOW - 5000 },
  });
  // A few seconds of clock skew ahead of now, and a time just inside the
  // 30-day window, both pass.
  expect(resolveRestorePoint({ at: NOW + 30 * 1000 }, NOW).ok).toBe(true);
  expect(
    resolveRestorePoint({ at: NOW - 30 * DAY_MS + MINUTE_MS }, NOW).ok,
  ).toBe(true);
});

test.each([
  ["neither a time nor a bookmark", {}],
  ["both a time and a bookmark", { at: NOW - 1000, bookmark: "bk-abc" }],
  ["an empty bookmark", { bookmark: "" }],
  ["a whitespace bookmark", { bookmark: "   " }],
  ["a time an hour in the future", { at: NOW + 60 * MINUTE_MS }],
  [
    "a time just outside the 30-day window",
    { at: NOW - 30 * DAY_MS - MINUTE_MS },
  ],
  ["an unparseable date string", { at: "not a date" }],
  ["a non-finite number", { at: Number.NaN }],
])("resolveRestorePoint rejects %s", (_label, input) => {
  expect(resolveRestorePoint(input, NOW).ok).toBe(false);
});
