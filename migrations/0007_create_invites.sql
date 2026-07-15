-- Per-email, single-use, email-bound invite codes (map #151 / ticket #251).
-- The waitlist (0005) collects interest; this table converts it into invites.
-- A row is minted + emailed by the admin-only POST /api/admin/invite (driven by
-- scripts/invite.ts), and redeemed at signup by worker/auth.ts's /sign-up/email
-- hook: the code validates ONLY when the signup email matches `email` (bound),
-- and `redeemedAt` is stamped once, atomically (single-use). Revoke by deleting
-- the row; no expiry in v1. `email` is the PRIMARY KEY so re-inviting the same
-- address is a no-op (INSERT ... ON CONFLICT DO NOTHING) that preserves the
-- original code. `code` is UNIQUE + indexed for the redeem lookup.
--
-- NOTE: this file is 0007 on the assumption Stripe's migration 0006 (PR #173)
-- lands first; wrangler applies migrations by sorted filename, so a gap is
-- harmless if it doesn't.
CREATE TABLE IF NOT EXISTS invites (
  email      TEXT PRIMARY KEY,   -- normalized (trimmed, lowercased): the bound address
  code       TEXT NOT NULL UNIQUE,
  sentAt     INTEGER NOT NULL,
  redeemedAt INTEGER             -- NULL until redeemed at signup
);
CREATE INDEX IF NOT EXISTS invites_code ON invites (code);
