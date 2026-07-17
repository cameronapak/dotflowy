/// <reference types="@cloudflare/workers-types" />

/**
 * Operator restore-one-user via the per-user Durable Object's free 30-day
 * Point-in-Time Recovery (ticket #220, map #151). Pure helpers live here so the
 * timestamp/bookmark validation is unit-testable without a DO; the DO RPC
 * (`UserOutlineDO.restoreToTime`) and the admin route (`worker/index.ts`) consume
 * `RestorePoint`. See docs/runbooks/restore-user-pitr.md.
 */

/**
 * Where to restore a DO to: either a wall-clock time (resolved to a bookmark by
 * `getBookmarkForTime` inside the DO) or a raw pre-recovery bookmark string (the
 * UNDO path — a prior restore returns its pre-recovery bookmark, and restoring to
 * it reverses a botched restore). The DO stays total over this validated shape.
 */
export type RestorePoint =
  | { kind: "time"; at: number }
  | { kind: "bookmark"; bookmark: string };

/** The rolling window Cloudflare PITR retains (30 days). A time outside it can't
 *  be resolved to a bookmark, so we reject it at the boundary with a clean 400
 *  rather than let `getBookmarkForTime` throw a 500 deep in the DO. */
export const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Small clock-skew grace so an operator pasting "now" (or a timestamp a few
 *  seconds ahead of the Worker's clock) isn't rejected as "in the future". */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export type RestorePointResult =
  | { ok: true; point: RestorePoint }
  | { ok: false; reason: string };

/**
 * Validate the restore target from an already-shape-decoded admin body. Pure and
 * unit-tested (worker/restore.test.ts): identity resolution (email → user id via
 * D1) stays in the route; this only decides WHERE in time to restore.
 *
 * Rules — EXACTLY one of `at` / `bookmark`:
 *  - `bookmark`: a non-empty string, used verbatim (the undo path). Not otherwise
 *    validated — a bogus bookmark fails inside CF's restore, which is the
 *    operator's problem, not a shape error.
 *  - `at`: an epoch-ms number OR an ISO date string, parsed to a finite epoch ms
 *    that sits within the last `RESTORE_WINDOW_MS` and is not in the future
 *    (beyond a small skew). Outside the window / unparseable → rejected here.
 */
export function resolveRestorePoint(
  input: { at?: string | number; bookmark?: string },
  now: number,
): RestorePointResult {
  const hasBookmark =
    typeof input.bookmark === "string" && input.bookmark.trim().length > 0;
  const hasAt = input.at !== undefined && input.at !== null && input.at !== "";

  if (hasBookmark && hasAt) {
    return {
      ok: false,
      reason: "provide either a restore time or a bookmark, not both",
    };
  }
  if (!hasBookmark && !hasAt) {
    return { ok: false, reason: "a restore time or a bookmark is required" };
  }

  if (hasBookmark) {
    return { ok: true, point: { kind: "bookmark", bookmark: input.bookmark! } };
  }

  const at = parseTimestamp(input.at!);
  if (at === null) {
    return { ok: false, reason: "restore time is not a valid date" };
  }
  if (at > now + FUTURE_SKEW_MS) {
    return { ok: false, reason: "restore time is in the future" };
  }
  if (at < now - RESTORE_WINDOW_MS) {
    return {
      ok: false,
      reason: "restore time is older than the 30-day recovery window",
    };
  }
  return { ok: true, point: { kind: "time", at } };
}

/** Coerce an epoch-ms number or an ISO/date string into finite epoch ms, or null
 *  if it doesn't parse. A bare number is treated as ms already. */
function parseTimestamp(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const trimmed = value.trim();
  // An all-digits string is epoch ms (a datetime-local input sends ISO, but a
  // curl caller may pass ms directly).
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}
