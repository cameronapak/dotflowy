/**
 * E2e global setup (ADR 0061): the stack's doctor.
 *
 * Playwright has already booted the webServer (scripts/e2e-serve.ts:
 * built SPA + `wrangler dev`, migrations applied) and waited on the port by
 * the time this runs. Here we prove the whole stack is REAL by driving the
 * one flow that touches everything: sign up a unique-per-run user through
 * the live Better Auth endpoint (Worker + D1 + the invite gate), then flip
 * `emailVerified` in local D1 - the same mechanics as `bun run seed:user`,
 * minus its fixed dev account.
 *
 * The unique email means reruns never couple to stale local state: every
 * run mints its own user, and no spec depends on any previous run's data.
 * If signup fails, the run fails here, loudly - not as mysterious spec
 * failures later.
 *
 * Runs in Node (Playwright's loader), not Bun: node: APIs only.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEV_VARS = resolve(ROOT, ".dev.vars");
const PORT = process.env.E2E_PORT ?? "3210";
const BASE = `http://localhost:${PORT}`;
const RUN = `${Date.now()}-${process.pid}`;
const EMAIL = `e2e-${RUN}@dotflowy.local`;
const PASSWORD = `dotflowy-e2e-${RUN}`;

/** dotenv-parsed `.dev.vars` contents (named contract: the parse is tiny,
 * the shape is exactly KEY -> trimmed string). */
type DevVars = Record<string, string>;

/** Parse `.dev.vars` the same tiny way scripts/seed-user.ts does. */
function parseDevVars(path: string) {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: DevVars = {};
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

/** Match the signup gate (worker/auth.ts hooks.before): invite code from
 * INVITE_CODES, or open signup when SIGNUP_OPEN is exactly "true". */
function resolveInvite(
  env: Record<string, string>,
): { inviteCode?: string } | null {
  const code = (env.INVITE_CODES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (code) return { inviteCode: code };
  if (env.SIGNUP_OPEN === "true") return {};
  return null;
}

/** Flip emailVerified in the same local D1 wrangler dev serves. Best-effort
 * warn (parity with seed-user): no spec signs in as this user today, but a
 * loud warning keeps a future spec from wedging silently. */
function markVerified(): void {
  const proc = spawnSync(
    "bunx",
    [
      "wrangler",
      "d1",
      "execute",
      "dotflowy-db",
      "--local",
      "--command",
      `UPDATE "user" SET "emailVerified" = 1 WHERE email = '${EMAIL}'`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (proc.status !== 0) {
    console.warn(
      `[e2e-global-setup] warning: couldn't mark ${EMAIL} verified ` +
        `(exit ${proc.status}): a spec that signs in as this user would wedge.`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  // Preflight: the origin must answer before we claim anything about it.
  try {
    const res = await fetch(`${BASE}/api/auth/ok`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    throw new Error(
      `e2e origin not healthy at ${BASE} (${String(err)}) - ` +
        `the webServer (scripts/e2e-serve.ts) must be up before global setup.`,
    );
  }

  const devVars = parseDevVars(DEV_VARS);
  const invite = resolveInvite(devVars);
  if (invite === null) {
    throw new Error(
      `Signup is closed in .dev.vars: no INVITE_CODES and SIGNUP_OPEN isn't "true". ` +
        `Run \`bun run setup\` (copies the documented local default) and re-run.`,
    );
  }

  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The e2e port is not the auth base URL (BETTER_AUTH_URL, :8787), so a
      // request with no Origin is cross-origin and Better Auth rejects it
      // with MISSING_OR_NULL_ORIGIN. Speak as the trusted base origin, the
      // same one scripts/seed-user.ts effectively posts to.
      origin: devVars.BETTER_AUTH_URL || "http://localhost:8787",
      // Turnstile is off locally unless TURNSTILE_SECRET_KEY is set; when the
      // always-pass TEST secret is configured, any token value passes.
      "x-captcha-response": "e2e-global-setup-dummy-token",
    },
    body: JSON.stringify({
      name: "E2E",
      email: EMAIL,
      password: PASSWORD,
      ...invite,
    }),
  });

  if (res.ok) {
    console.log(
      `[e2e-global-setup] signed up ${EMAIL} through the real signup`,
    );
    markVerified();
    return;
  }
  const text = await res.text();
  throw new Error(
    `e2e stack doctor failed: sign-up returned ${res.status}: ${text}`,
  );
}
