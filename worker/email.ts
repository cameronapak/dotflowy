/// <reference types="@cloudflare/workers-types" />

/**
 * The ONE transactional-email seam (map #151 / ticket #169). Every sender —
 * password reset today; invites, waitlist mails later — goes through
 * `sendEmail`, so the provider is swappable in this single file. The current
 * provider is Cloudflare Email Service via the Workers `send_email` binding
 * (wrangler.jsonc): a binding, not an API key, so there is no secret to leak
 * or rotate. Named fallback if the beta bites: Resend (same signature, swap
 * the body of `sendEmail`).
 */

/** The slice of the Worker env this seam needs. */
export interface EmailEnv {
  /** The `send_email` binding. Local `wrangler dev` SIMULATES it (miniflare
   *  logs the full message — reset URL included — to the console instead of
   *  sending), so `bun run dev` stays zero-config; `"remote": true` on the
   *  binding opts into real sends through dev. Optional so environments with
   *  no binding at all (unit tests, a trimmed config) degrade to the console
   *  fallback below instead of crashing. */
  EMAIL?: SendEmail;
}

/** The sender identity, pinned here AND in the binding's
 *  `allowed_sender_addresses` (defense in depth: the binding rejects any other
 *  From even if a future caller tries one). */
const FROM = "Dotflowy <no-reply@dotflowy.com>";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Send a transactional email. Never throws: callers sit on non-enumerable
 * endpoints (a failed reset send must not turn into a distinguishable
 * response), so failures are logged for observability and swallowed. Always
 * provide both html and text (spam score + client compatibility).
 */
export async function sendEmail(
  env: EmailEnv,
  message: EmailMessage,
): Promise<void> {
  if (!env.EMAIL) {
    // No binding in this environment: log the whole message so any embedded
    // URL is copy-pasteable from the console.
    console.log(
      `[email dev fallback] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
    );
    return;
  }
  try {
    await env.EMAIL.send({
      from: FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  } catch (err) {
    console.error(`email send failed (to=${message.to}):`, err);
  }
}
