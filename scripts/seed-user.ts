/**
 * Seeds a ready-to-use dev account against a running local Worker, through
 * the REAL Better Auth sign-up endpoint (`POST /api/auth/sign-up/email`) —
 * not a direct D1 insert. Better Auth hashes passwords with its own scrypt
 * scheme; reproducing that hash to write a row by hand is fragile and breaks
 * on any Better Auth upgrade. Going through the live endpoint uses the real
 * code path, so this script carries zero hash logic. The cost: the Worker
 * must already be running (`bun run dev` / `bun run dev:api`).
 *
 * Idempotent: re-running after the account exists is a no-op that exits 0.
 *
 * These are well-known dev credentials for a LOCAL, invite-gated instance
 * (documented in README/CONTRIBUTING so testers can sign in immediately).
 * Not a production secret — API is hardcoded to localhost on purpose; never
 * point this at a non-local origin.
 *
 * Email verification (#293): signup is now `requireEmailVerification`, so a
 * freshly-created account can't sign in until it's verified. This script has no
 * inbox to click, so after signup it flips `emailVerified` directly in the
 * local D1 (wrangler d1 execute --local, same state dir bun run dev uses) —
 * keeping the dev account immediately sign-in-able.
 *
 * Invite code: the signup gate (worker/auth.ts hooks.before) accepts only a
 * code that's in the local `.dev.vars` `INVITE_CODES` secret (or SIGNUP_OPEN).
 * Rather than hardcode `dev-invite` — which only works when .dev.vars still
 * carries that default — this reads the local `.dev.vars` and derives the code
 * from it, so the seed works on any box whatever its INVITE_CODES value is.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const API = "http://localhost:8787";
const EMAIL = "dev@dotflowy.local";
const PASSWORD = "dotflowy-dev";

// Resolve .dev.vars from the checkout this script lives in (not cwd, not a
// hardcoded absolute path) — `import.meta.dir` is `<root>/scripts`, matching
// scripts/setup.ts, so it points at this worktree's own .dev.vars.
const DEV_VARS = resolve(import.meta.dir, "..", ".dev.vars");

/**
 * Parse a `.dev.vars` (dotenv-style `KEY=VALUE`) into a map. Blank lines and
 * `#` comments are ignored; a single layer of surrounding single/double quotes
 * is stripped. Deliberately tiny — no dependency, no `export`/interpolation
 * handling `.dev.vars` doesn't use.
 */
function parseDevVars(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * The first invite code from a comma-separated INVITE_CODES value. Mirrors
 * `splitList` in worker/identity.ts EXACTLY (`split(",")` -> trim -> drop
 * empties) so the code this script picks is one the signup gate will accept.
 */
function firstInviteCode(inviteCodes: string | undefined): string | undefined {
  return (inviteCodes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
}

/**
 * Decide how to authorize the signup from the local `.dev.vars`, matching the
 * worker/auth.ts hooks.before gate:
 *  - INVITE_CODES set   -> send its first code as `inviteCode`.
 *  - else SIGNUP_OPEN === "true" -> open signup, no invite required.
 *  - neither            -> CLOSED; the gate would 403. Return null so the
 *    caller can bail BEFORE the request with an actionable message.
 */
function resolveInvite(
  env: Record<string, string>,
): { inviteCode?: string } | null {
  const code = firstInviteCode(env.INVITE_CODES);
  if (code) return { inviteCode: code };
  if (env.SIGNUP_OPEN === "true") return {};
  return null;
}

/**
 * Mark the dev account verified in the local D1 so it can sign in. Best-effort:
 * a wrangler failure warns but doesn't fail the seed (the account still exists;
 * you can verify it by hand). Uses the same `dotflowy-db --local` binding the
 * migrations do, so it targets the DB `bun run dev` serves.
 */
function markVerified(): void {
  const proc = Bun.spawnSync(
    [
      "wrangler",
      "d1",
      "execute",
      "dotflowy-db",
      "--local",
      "--command",
      `UPDATE "user" SET "emailVerified" = 1 WHERE email = '${EMAIL}'`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    console.warn(
      `warning: couldn't mark ${EMAIL} verified automatically (exit ${proc.exitCode}). ` +
        `Run it by hand if sign-in is blocked:\n` +
        `  wrangler d1 execute dotflowy-db --local --command "UPDATE \\"user\\" SET \\"emailVerified\\" = 1 WHERE email = '${EMAIL}'"`,
    );
  }
}

async function main(): Promise<void> {
  // Derive the signup authorization from the local .dev.vars BEFORE hitting the
  // network — if signup is closed here, a request would just 403.
  const invite = resolveInvite(parseDevVars(DEV_VARS));
  if (invite === null) {
    console.error(
      `Signup is closed in ${DEV_VARS}: no INVITE_CODES and SIGNUP_OPEN isn't "true".\n` +
        `Fix one of:\n` +
        `  - add INVITE_CODES=dev-invite to .dev.vars (the documented local default), or\n` +
        `  - set SIGNUP_OPEN=true in .dev.vars to open self-serve signup.`,
    );
    process.exit(1);
  }

  // Preflight: make sure the Worker is actually up before attempting the
  // real sign-up POST, so a connection-refused doesn't read as an auth error.
  try {
    await fetch(`${API}/api/auth/ok`);
  } catch {
    console.error(`Worker not reachable at ${API}. Run \`bun run dev\` first.`);
    process.exit(1);
  }

  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Turnstile is OFF locally unless you set TURNSTILE_SECRET_KEY. When you
      // set it to Cloudflare's always-pass TEST secret (see .dev.vars.example),
      // the captcha plugin still needs SOME token — the always-pass secret
      // accepts any value, so this dummy satisfies it. Ignored when the plugin
      // isn't registered.
      "x-captcha-response": "seed-user-dummy-token",
    },
    // `inviteCode` is omitted entirely under open signup (invite = {}); the gate
    // skips the invite check, and the after-hook has nothing to redeem.
    body: JSON.stringify({
      name: "Dev",
      email: EMAIL,
      password: PASSWORD,
      ...invite,
    }),
  });

  if (res.ok) {
    console.log(`created ${EMAIL} (password: ${PASSWORD})`);
    markVerified();
  } else {
    const text = await res.text();

    if (res.status >= 400 && res.status < 500 && /exist/i.test(text)) {
      console.log(
        `${EMAIL} already exists - sign in with password: ${PASSWORD}`,
      );
      // Re-run safety: an account created before this change (or by a prior
      // failed run) may still be unverified. Flip it either way — idempotent.
      markVerified();
    } else if (res.status === 403 || /FORBIDDEN/i.test(text)) {
      console.error(`sign-up rejected (status ${res.status}): ${text}`);
      process.exit(1);
    } else {
      console.error(`sign-up failed (status ${res.status}): ${text}`);
      process.exit(1);
    }
  }

  console.log(`Sign in at http://localhost:3000 with ${EMAIL} / ${PASSWORD}`);
}

await main();
