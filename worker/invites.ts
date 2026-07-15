/// <reference types="@cloudflare/workers-types" />

/**
 * Waitlist -> invite conversion (map #151 / ticket #251). Per-email, single-use,
 * email-bound invite codes: the waitlist (migration 0005) collects interest, an
 * admin mints codes from it (POST /api/admin/invite, driven by scripts/invite.ts),
 * and worker/auth.ts's /sign-up/email hook redeems one at signup.
 *
 * Two halves live here:
 *  - MINT/SEND (mintInvites, pendingWaitlistEmails) — runs on the Worker because
 *    the email send needs the `send_email` binding, which only exists inside
 *    `fetch`. The invite script drives it over the admin HTTP endpoint.
 *  - REDEEM (isRedeemableInvite, redeemInvite) — called from the signup hook.
 *    Validation (a SELECT) is separate from the stamp (a conditional UPDATE) so
 *    the signup hook can validate in `before` and only burn the code in `after`,
 *    once the account actually exists.
 */

import { sendEmail } from "./email";

/** The env slice the invite flow needs: D1 (the `invites` + `waitlist` tables)
 *  and the email seam. */
export interface InviteEnv {
  DB: D1Database;
  /** The `send_email` binding; absent in plain local dev (sends log instead). */
  EMAIL?: SendEmail;
}

/** A minted invite: the code and the email it's bound to. */
export interface MintedInvite {
  email: string;
  code: string;
}

/** The result of a batch mint: fresh invites vs. addresses already invited. */
export interface InviteBatchResult {
  invited: MintedInvite[];
  skipped: string[];
}

// Unambiguous alphabet — no 0/O/1/I/L — so a code read off an email can't be
// mistyped. 12 chars over 31 symbols ≈ 59 bits: overkill for an email-bound,
// single-use code, but codes are cheap to mint.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;

/** Mint a random, URL-safe invite code. */
export function generateInviteCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

/** Normalize an email the same way the waitlist + admin allowlist do, so the
 *  bound `email` compares identically at mint time and redeem time. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The invite email (HTML + text; both always sent). Email-bound, so it tells
 *  the recipient to sign up with THIS address — the code only validates for it. */
export function inviteEmail(code: string, signupUrl: string, email: string) {
  return {
    subject: "You're invited to Dotflowy",
    text: `You're invited to Dotflowy.\n\nYour invite code: ${code}\n\nSign up at ${signupUrl} using this email address (${email}) — the code only works for it, and only once.\n\nSee you inside.`,
    html: `<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 28rem; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 18px; font-weight: 600;">You're invited to Dotflowy</h1>
  <p style="font-size: 14px; color: #444; line-height: 1.5;">Your invite is ready. Use this code when you sign up:</p>
  <p style="margin: 20px 0;"><code style="display: inline-block; background: #f4f4f5; border: 1px solid #e4e4e7; font-size: 18px; letter-spacing: 2px; padding: 10px 16px; border-radius: 6px; font-family: ui-monospace, monospace;">${code}</code></p>
  <p style="margin: 24px 0;"><a href="${signupUrl}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; font-size: 14px; padding: 10px 16px; border-radius: 6px;">Create your account</a></p>
  <p style="font-size: 13px; color: #666; line-height: 1.5;">Sign up with <strong>${email}</strong> — the code is bound to this address and works only once.</p>
</div>`,
  };
}

/** Waitlist addresses not yet invited (no `invites` row), oldest first. `limit`
 *  null = every pending row. */
export async function pendingWaitlistEmails(
  env: InviteEnv,
  limit: number | null,
): Promise<string[]> {
  const base =
    "SELECT w.email AS email FROM waitlist w " +
    "LEFT JOIN invites i ON i.email = w.email " +
    "WHERE i.email IS NULL ORDER BY w.createdAt ASC";
  const stmt =
    limit != null
      ? env.DB.prepare(`${base} LIMIT ?`).bind(limit)
      : env.DB.prepare(base);
  const { results } = await stmt.all<{ email: string }>();
  return results.map((r) => r.email);
}

/**
 * Mint + email a fresh invite for each address. `ON CONFLICT(email) DO NOTHING`
 * makes it idempotent: an address already invited keeps its original code and is
 * skipped (no duplicate email). `meta.changes` tells us which insert won its row,
 * so an email only goes out for a genuinely new invite.
 */
export async function mintInvites(
  env: InviteEnv,
  emails: string[],
  signupUrl: string,
): Promise<InviteBatchResult> {
  const invited: MintedInvite[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const code = generateInviteCode();
    const res = await env.DB.prepare(
      "INSERT INTO invites (email, code, sentAt, redeemedAt) VALUES (?, ?, ?, NULL) ON CONFLICT(email) DO NOTHING",
    )
      .bind(email, code, Date.now())
      .run();
    if (res.meta.changes === 0) {
      skipped.push(email);
      continue;
    }
    // sendEmail never throws (logs + swallows), so a delivery failure leaves the
    // invites row in place — resendable by deleting the row and re-minting.
    await sendEmail(env, { to: email, ...inviteEmail(code, signupUrl, email) });
    invited.push({ email, code });
  }
  return { invited, skipped };
}

/**
 * True if `code` is an unredeemed invite bound to `email` (both normalized by
 * the caller). The READ half of redemption — validation only, no write — so the
 * signup hook can accept in `before` without burning the code on a later failure.
 */
export async function isRedeemableInvite(
  env: InviteEnv,
  email: string,
  code: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM invites WHERE code = ? AND email = ? AND redeemedAt IS NULL LIMIT 1",
  )
    .bind(code, email)
    .first();
  return row != null;
}

/**
 * Atomically stamp an invite redeemed. Conditional on `redeemedAt IS NULL` so
 * two concurrent redemptions of one code can't both win; returns whether THIS
 * call claimed it. A no-op (0 rows) when `code` is the shared INVITE_CODES
 * backdoor rather than an `invites` row.
 */
export async function redeemInvite(
  env: InviteEnv,
  email: string,
  code: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE invites SET redeemedAt = ? WHERE code = ? AND email = ? AND redeemedAt IS NULL",
  )
    .bind(Date.now(), code, email)
    .run();
  return res.meta.changes === 1;
}
