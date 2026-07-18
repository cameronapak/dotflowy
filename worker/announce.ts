/// <reference types="@cloudflare/workers-types" />

/**
 * Launch-day "Dotflowy is open" blast (map #151 / ticket #294). When signup
 * graduates from invite-only to public, every waitlist row (migration 0005) gets
 * one announcement email. The counterpart to worker/invites.ts's MINT/SEND half:
 * same shape, same reasons.
 *
 *  - The send runs on the Worker because it goes through the ONE email seam
 *    (worker/email.ts -> the `send_email` binding), which only exists inside
 *    `fetch`. scripts/announce.ts is the thin admin-authenticated trigger.
 *  - Idempotency is a `notifiedAt` stamp on the waitlist row (migration 0009),
 *    mirroring `invites.redeemedAt`: a row is claimed by a CONDITIONAL UPDATE
 *    (`WHERE notifiedAt IS NULL`) and only the winner sends, so a re-run or a
 *    concurrent batch can't double-send. That's what makes the CLI resumable.
 *
 * Unlike an invite, the announcement carries no per-recipient secret — every
 * waiter gets the identical message — so the email body is built once per batch.
 */

import { sendEmail } from "./email";
import { normalizeEmail } from "./invites";

/** The env slice the announcement flow needs: D1 (the `waitlist` table) and the
 *  email seam. */
export interface AnnounceEnv {
  DB: D1Database;
  /** The `send_email` binding; absent in plain local dev (sends log instead). */
  EMAIL?: SendEmail;
}

/** The result of a batch: addresses freshly emailed vs. addresses skipped
 *  (already notified, or not on the waitlist). */
export interface AnnounceBatchResult {
  notified: string[];
  skipped: string[];
}

/** The launch announcement (HTML + text; both always sent, per the email seam's
 *  spam-score + client-compat rule). One message for everyone — no per-recipient
 *  secret — so it takes only the public signup URL. Facts (free tier, pricing,
 *  founding plan) are pinned to ticket #294; keep them honest if edited. */
export function announceEmail(signupUrl: string) {
  return {
    subject: "Dotflowy is open",
    text: `You joined the Dotflowy waitlist a while back. Thanks for waiting.

Signup's open now, no invite code needed: ${signupUrl}

The free plan is the whole outliner: up to 10,000 live nodes, export always free, and going over the cap never locks you out.

If you want more, unlimited nodes plus agents is $5/mo or $48/yr. There's also a founding plan, $99 for 3 years, capped at 50 seats. It auto-renews after year three unless you cancel. Not a lifetime deal.

Your account's ready when you are: ${signupUrl}

— from Cam Pak
dotflowy.com

(Written by Claude to be organized well, content and heart from Cam.)`,
    html: `<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 32rem; margin: 0 auto; padding: 24px; color: #111; line-height: 1.5;">
  <h1 style="font-size: 18px; font-weight: 600;">Dotflowy is open</h1>
  <p style="font-size: 14px; color: #444;">You joined the Dotflowy waitlist a while back. Thanks for waiting.</p>
  <p style="font-size: 14px; color: #444;">Signup's open now, no invite code needed.</p>
  <p style="margin: 20px 0;"><a href="${signupUrl}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; font-size: 14px; padding: 10px 16px; border-radius: 6px;">Create your account</a></p>
  <p style="font-size: 14px; color: #444;">The free plan is the whole outliner: up to 10,000 live nodes, export always free, and going over the cap never locks you out.</p>
  <p style="font-size: 14px; color: #444;">If you want more, unlimited nodes plus agents is <strong>$5/mo</strong> or <strong>$48/yr</strong>. There's also a founding plan, <strong>$99 for 3 years</strong>, capped at 50 seats. It auto-renews after year three unless you cancel. Not a lifetime deal.</p>
  <p style="font-size: 14px; color: #444;">Your account's ready when you are: <a href="${signupUrl}" style="color: #111;">${signupUrl}</a></p>
  <p style="font-size: 13px; color: #666; margin-bottom: 4px;">— from Cam Pak<br>dotflowy.com</p>
  <p style="font-size: 12px; color: #999;">(Written by Claude to be organized well, content and heart from Cam.)</p>
</div>`,
  };
}

/** Waitlist addresses not yet announced to (`notifiedAt IS NULL`), oldest first.
 *  `limit` null = every pending row. Mirrors invites' pendingWaitlistEmails. */
export async function pendingAnnounceEmails(
  env: AnnounceEnv,
  limit: number | null,
): Promise<string[]> {
  const base =
    "SELECT email FROM waitlist WHERE notifiedAt IS NULL ORDER BY createdAt ASC";
  const stmt =
    limit != null
      ? env.DB.prepare(`${base} LIMIT ?`).bind(limit)
      : env.DB.prepare(base);
  const { results } = await stmt.all<{ email: string }>();
  return results.map((r) => r.email);
}

/**
 * Email the announcement to each address, claiming each waitlist row first so a
 * send happens at most once. The claim is a CONDITIONAL UPDATE stamping
 * `notifiedAt` only `WHERE notifiedAt IS NULL`; `meta.changes === 1` means THIS
 * call won the row (mirrors mintInvites reading `meta.changes` off its
 * INSERT ... ON CONFLICT). A row already stamped — a re-run, a concurrent batch,
 * or an address that isn't on the waitlist at all — flips 0 rows and is skipped,
 * so no one is emailed twice.
 *
 * The stamp lands BEFORE the send, and sendEmail never throws (it logs and
 * swallows), so a delivery failure leaves the row stamped — same trade as
 * mintInvites, and resendable the same way: clear `notifiedAt` for those rows
 * and re-run. That's the deliberate choice for an at-most-once blast.
 */
export async function sendAnnouncements(
  env: AnnounceEnv,
  emails: string[],
  signupUrl: string,
): Promise<AnnounceBatchResult> {
  const notified: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  // Identical for everyone (no per-recipient secret) — build once.
  const message = announceEmail(signupUrl);
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const res = await env.DB.prepare(
      "UPDATE waitlist SET notifiedAt = ? WHERE email = ? AND notifiedAt IS NULL",
    )
      .bind(Date.now(), email)
      .run();
    if (res.meta.changes === 0) {
      skipped.push(email);
      continue;
    }
    await sendEmail(env, { to: email, ...message });
    notified.push(email);
  }
  return { notified, skipped };
}
