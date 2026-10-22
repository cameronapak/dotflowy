/**
 * Waitlist -> invite CLI (map #151 / ticket #251). Mints per-email, single-use,
 * email-bound invite codes and emails them, by driving the admin-only
 * `POST /api/admin/invite` endpoint (worker/index.ts).
 *
 * Why an endpoint and not direct D1 + a mailer: the invite email goes through
 * the ONE email seam (worker/email.ts -> the Cloudflare `send_email` binding),
 * and that binding only exists inside the Worker's `fetch`. So the Worker mints,
 * stores, and sends; this script is the thin admin-authenticated trigger.
 *
 * Auth: signs in as an admin (email + password) through the real Better Auth
 * endpoint — the same pattern as scripts/seed-user.ts — and forwards the session
 * cookie. Set a session cookie directly with DOTFLOWY_SESSION_COOKIE to skip the
 * sign-in (e.g. copied from the browser). The admin email must be on the
 * ADMIN_EMAILS allowlist (wrangler.jsonc) or the endpoint 404s.
 *
 * Config (env):
 *   DOTFLOWY_API              base URL (default https://app.dotflowy.com)
 *   DOTFLOWY_ADMIN_EMAIL      admin account email (for sign-in)
 *   DOTFLOWY_ADMIN_PASSWORD   admin account password (for sign-in)
 *   DOTFLOWY_SESSION_COOKIE   raw Cookie header, an alternative to sign-in
 *
 * Usage:
 *   bun run invite a@b.com c@d.com     # invite these exact addresses
 *   bun run invite --limit 10          # invite the 10 oldest pending waitlist rows
 *   bun run invite --all               # invite every pending waitlist row
 *   bun run invite --api http://localhost:8787 --all   # against local dev
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
        "  bun run invite a@b.com\n" +
        "  bun run invite --limit 10\n" +
        "  bun run invite --all",
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
      "Set DOTFLOWY_ADMIN_EMAIL + DOTFLOWY_ADMIN_PASSWORD (an admin on ADMIN_EMAILS),\n" +
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

interface InviteResponse {
  invited: { email: string; code: string }[];
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

  const res = await fetch(`${args.api}/api/admin/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`invite failed (status ${res.status}): ${await res.text()}`);
    process.exit(1);
  }

  const data = (await res.json()) as InviteResponse;
  if (data.invited.length === 0) {
    console.log("No new invites minted (all targets were already invited).");
  } else {
    console.log(`Minted ${data.invited.length} invite(s):`);
    for (const { email, code } of data.invited) {
      console.log(`  ${email}  ${code}`);
    }
  }
  if (data.skipped.length > 0) {
    console.log(
      `Skipped ${data.skipped.length} already-invited: ${data.skipped.join(", ")}`,
    );
  }
}

await main();
