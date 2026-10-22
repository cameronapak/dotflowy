/**
 * Waitlist launch-announcement CLI (map #151 / ticket #294). Emails the
 * "Dotflowy is open" blast to waitlist rows by driving the admin-only
 * `POST /api/admin/announce` endpoint (worker/index.ts).
 *
 * Why an endpoint and not direct D1 + a mailer: the email goes through the ONE
 * email seam (worker/email.ts -> the Cloudflare `send_email` binding), and that
 * binding only exists inside the Worker's `fetch`. So the Worker sends and
 * stamps `notifiedAt`; this script is the thin admin-authenticated trigger.
 *
 * Batched + resumable + safe to re-run: each call announces at most `--limit`
 * rows (default 25, max 500) and the Worker stamps `notifiedAt` on every row it
 * sends, so a row is never emailed twice — re-run until `--all` reports zero new.
 * Loop it to drain the whole list:
 *
 *   while bun run announce --limit 200 | grep -q 'Announced'; do :; done
 *
 * Auth: signs in as an admin (email + password) through the real Better Auth
 * endpoint — the same pattern as scripts/invite.ts — and forwards the session
 * cookie. Set a session cookie directly with DOTFLOWY_SESSION_COOKIE to skip the
 * sign-in (e.g. copied from the browser). The admin must satisfy the endpoint's
 * gate (ADMIN_USER_IDS / ADMIN_EMAILS, wrangler.jsonc) or the endpoint 404s.
 *
 * Config (env):
 *   DOTFLOWY_API              base URL (default https://app.dotflowy.com)
 *   DOTFLOWY_ADMIN_EMAIL      admin account email (for sign-in)
 *   DOTFLOWY_ADMIN_PASSWORD   admin account password (for sign-in)
 *   DOTFLOWY_SESSION_COOKIE   raw Cookie header, an alternative to sign-in
 *
 * Usage:
 *   bun run announce --limit 200        # announce to the 200 oldest un-notified rows
 *   bun run announce --all              # announce to every un-notified waitlist row
 *   bun run announce a@b.com c@d.com    # announce to these exact addresses
 *   bun run announce --api http://localhost:8787 --all   # against local dev
 */

interface Args {
  emails: string[];
  all: boolean;
  limit?: number;
  api: string;
}

function parseArgs(argv: string[]): Args {
  const emails: string[] = [];
  let all = false;
  let limit: number | undefined;
  let api = process.env.DOTFLOWY_API ?? "https://app.dotflowy.com";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--all") {
      all = true;
    } else if (arg === "--limit" || arg === "--count") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) {
        console.error(`${arg} needs a positive number`);
        process.exit(1);
      }
      limit = Math.floor(n);
    } else if (arg === "--api") {
      api = argv[++i] ?? api;
    } else if (arg.startsWith("--")) {
      console.error(`unknown flag: ${arg}`);
      process.exit(1);
    } else {
      emails.push(arg);
    }
  }

  if (emails.length === 0 && !all && limit == null) {
    console.error(
      "Nothing to do. Pass emails, or --all, or --limit N.\n" +
        "  bun run announce --limit 200\n" +
        "  bun run announce --all\n" +
        "  bun run announce a@b.com",
    );
    process.exit(1);
  }
  return { emails, all, limit, api: api.replace(/\/$/, "") };
}

/** Collapse a fetch Response's Set-Cookie headers into a single Cookie header. */
function collectCookies(res: Response): string {
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter((v): v is string => v != null);
  return setCookies
    .map((c) => c.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

/** Obtain a Cookie header: an explicit one, else sign in as the admin. */
async function resolveCookie(api: string): Promise<string> {
  const explicit = process.env.DOTFLOWY_SESSION_COOKIE;
  if (explicit) return explicit;

  const email = process.env.DOTFLOWY_ADMIN_EMAIL;
  const password = process.env.DOTFLOWY_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error(
      "Set DOTFLOWY_ADMIN_EMAIL + DOTFLOWY_ADMIN_PASSWORD (an admin on the allowlist),\n" +
        "or DOTFLOWY_SESSION_COOKIE with a signed-in session cookie.",
    );
    process.exit(1);
  }

  const res = await fetch(`${api}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    console.error(
      `admin sign-in failed (status ${res.status}): ${await res.text()}`,
    );
    process.exit(1);
  }
  const cookie = collectCookies(res);
  if (!cookie) {
    console.error("admin sign-in returned no session cookie");
    process.exit(1);
  }
  return cookie;
}

interface AnnounceResponse {
  notified: string[];
  skipped: string[];
  count: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cookie = await resolveCookie(args.api);

  const body: { emails?: string[]; all?: boolean; limit?: number } =
    args.emails.length > 0
      ? { emails: args.emails }
      : args.all
        ? { all: true }
        : { limit: args.limit };

  const res = await fetch(`${args.api}/api/admin/announce`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(
      `announce failed (status ${res.status}): ${await res.text()}`,
    );
    process.exit(1);
  }

  const data = (await res.json()) as AnnounceResponse;
  if (data.notified.length === 0) {
    console.log(
      "No new announcements sent (all targets were already notified).",
    );
  } else {
    console.log(`Announced to ${data.notified.length} address(es):`);
    for (const email of data.notified) {
      console.log(`  ${email}`);
    }
  }
  if (data.skipped.length > 0) {
    console.log(
      `Skipped ${data.skipped.length} already-notified (or not on the waitlist).`,
    );
  }
}

await main();
