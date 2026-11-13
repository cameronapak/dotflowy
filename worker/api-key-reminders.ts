/// <reference types="@cloudflare/workers-types" />

import { captureDigest, type ApiKeyPermission } from "./capture-input";
import { sendEmail, type EmailEnv } from "./email";

interface ReminderEnv extends EmailEnv {
  DB: D1Database;
  BETTER_AUTH_URL?: string;
}

interface DueKey {
  id: string;
  name: string;
  permission: ApiKeyPermission;
  expiresAt: number;
  credentialVersion: string;
  password: string;
  email: string;
}

const LEAD_MS = 7 * 86400_000;
const CLAIM_MS = 5 * 60_000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]!;
  });
}

function reminderEmail(key: DueKey, settingsUrl: string) {
  const permission = {
    capture: "Capture only",
    read: "Read-only",
    write: "Read and write",
  }[key.permission];
  const expiry = new Date(key.expiresAt).toISOString();
  return {
    to: key.email,
    subject: "Your Dotflowy API key expires soon",
    text: `Your API key “${key.name}” (${permission}) expires on ${expiry} (UTC).\n\nManage it in Dotflowy Settings → Connections → API keys: ${settingsUrl}\n\nReplace the key in each shortcut or script that uses it. Keys do not renew automatically.`,
    html: `<p>Your API key <strong>${escapeHtml(key.name)}</strong> (${escapeHtml(permission)}) expires on ${escapeHtml(expiry)} (UTC).</p>
<p><a href="${escapeHtml(settingsUrl)}">Dotflowy Settings → Connections → API keys</a></p>
<p>Replace the key in each shortcut or script that uses it. Keys do not renew automatically.</p>`,
  };
}

/** Public daily sweep; callers must park this promise on ctx.waitUntil.
 * A successful binding acceptance stamps only this expiration. Failures release
 * the lease; interruptions leave a five-minute lease, never a permanent stamp.
 * Provider acceptance followed by interruption before the stamp can duplicate a
 * reminder on retry: exactly-once delivery needs provider idempotency, which the
 * current binding does not offer. Claims prevent normal concurrent duplicates.
 */
export async function runApiKeyReminderSweep(
  env: ReminderEnv,
  now = Date.now(),
): Promise<void> {
  // Cron has no request origin. Never infer a link from recipient-controlled
  // data or silently send a self-hoster to the hosted app.
  if (!env.EMAIL || !env.BETTER_AUTH_URL) return;
  const origin = new URL(env.BETTER_AUTH_URL);
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return;
  const settingsUrl = new URL("/settings#capture-keys", origin.origin).href;
  const startedAt = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT k.id, k.name, k.permission, k.expiresAt, k.credentialVersion,
            a.password, u.email
     FROM capture_key k JOIN "user" u ON u.id = k.userId
     JOIN account a ON a.userId = u.id AND a.providerId = 'credential'
     WHERE u.emailVerified = 1 AND a.password IS NOT NULL
       AND k.expiresAt > ? AND k.expiresAt <= ?
       AND (k.reminderNotifiedExpiresAt IS NULL OR k.reminderNotifiedExpiresAt != k.expiresAt)
       AND (k.reminderClaimUntil IS NULL OR k.reminderClaimUntil <= ?)
     ORDER BY k.expiresAt, k.id`,
  )
    .bind(now, now + LEAD_MS, now)
    .all<DueKey>();

  for (const key of results) {
    try {
      if (key.credentialVersion !== (await captureDigest(key.password)))
        continue;
      const claimTime = now + Date.now() - startedAt;
      const token = crypto.randomUUID();
      const claim = await env.DB.prepare(
        `UPDATE capture_key SET reminderClaimToken = ?, reminderClaimUntil = ?
         WHERE id = ? AND expiresAt = ? AND expiresAt > ? AND credentialVersion = ?
           AND (reminderNotifiedExpiresAt IS NULL OR reminderNotifiedExpiresAt != expiresAt)
           AND (reminderClaimUntil IS NULL OR reminderClaimUntil <= ?)
           AND EXISTS (SELECT 1 FROM "user" u JOIN account a ON a.userId = u.id
             WHERE u.id = capture_key.userId AND u.emailVerified = 1 AND u.email = ?
               AND a.providerId = 'credential' AND a.password = ?)`,
      )
        .bind(
          token,
          claimTime + CLAIM_MS,
          key.id,
          key.expiresAt,
          claimTime,
          key.credentialVersion,
          claimTime,
          key.email,
          key.password,
        )
        .run();
      if (claim.meta.changes !== 1) continue;

      // Recheck after claiming: password changes, deletion, revocation, and
      // rotation can race the initial candidate read. No DB transaction can
      // extend across the external send, so a change during send may still mail.
      const sendTime = now + Date.now() - startedAt;
      const live = await env.DB.prepare(
        `SELECT k.id FROM capture_key k JOIN "user" u ON u.id = k.userId
         JOIN account a ON a.userId = u.id AND a.providerId = 'credential'
         WHERE k.id = ? AND k.expiresAt = ? AND k.credentialVersion = ?
           AND k.reminderClaimToken = ? AND u.emailVerified = 1
           AND u.email = ? AND a.password = ?
           AND k.expiresAt > ? AND k.reminderClaimUntil > ?`,
      )
        .bind(
          key.id,
          key.expiresAt,
          key.credentialVersion,
          token,
          key.email,
          key.password,
          sendTime,
          sendTime,
        )
        .first();
      const outcome = live
        ? await sendEmail(env, reminderEmail(key, settingsUrl))
        : undefined;
      const delivered = outcome?.status === "accepted";
      await env.DB.prepare(
        `UPDATE capture_key
         SET reminderNotifiedExpiresAt = CASE WHEN ? THEN ? ELSE reminderNotifiedExpiresAt END,
             reminderClaimToken = NULL, reminderClaimUntil = NULL
         WHERE id = ? AND expiresAt = ? AND reminderClaimToken = ?`,
      )
        .bind(delivered ? 1 : 0, key.expiresAt, key.id, key.expiresAt, token)
        .run();
    } catch (error) {
      // One broken key must not starve the rest. A failed DB write retains at
      // most the bounded claim; the next daily sweep can retry it.
      console.error(`API key reminder failed (id=${key.id})`, error);
    }
  }
}
