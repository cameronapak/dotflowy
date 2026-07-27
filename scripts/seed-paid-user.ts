/**
 * One-shot local helper: create `paid@dotflowy.local` via Better Auth signup,
 * mark verified, and insert an operator-comped `unlimited` subscription so the
 * inline `@agent` paid gate can be dogfooded. Local D1 only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const API = "http://localhost:8787";
const EMAIL = "paid@dotflowy.local";
const PASSWORD = "dotflowy-paid";
const NAME = "Paid Dev";
const DEV_VARS = resolve(import.meta.dir, "..", ".dev.vars");

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

function firstInviteCode(inviteCodes: string | undefined): string | undefined {
  return (inviteCodes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
}

function d1Json(command: string): unknown {
  const proc = Bun.spawnSync(
    [
      "bunx",
      "wrangler",
      "d1",
      "execute",
      "dotflowy-db",
      "--local",
      "--json",
      "--command",
      command,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `d1 failed (${proc.exitCode}): ${proc.stderr.toString() || proc.stdout.toString()}`,
    );
  }
  return JSON.parse(proc.stdout.toString());
}

function d1(command: string): void {
  const proc = Bun.spawnSync(
    [
      "bunx",
      "wrangler",
      "d1",
      "execute",
      "dotflowy-db",
      "--local",
      "--command",
      command,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `d1 failed (${proc.exitCode}): ${proc.stderr.toString() || proc.stdout.toString()}`,
    );
  }
}

async function main(): Promise<void> {
  try {
    await fetch(`${API}/api/auth/ok`);
  } catch {
    console.error(
      `Worker not reachable at ${API}. Run \`bun run cf:dev\` first.`,
    );
    process.exit(1);
  }

  const inviteCode = firstInviteCode(parseDevVars(DEV_VARS).INVITE_CODES);
  const body: Record<string, string> = {
    name: NAME,
    email: EMAIL,
    password: PASSWORD,
  };
  if (inviteCode) body.inviteCode = inviteCode;

  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-captcha-response": "seed-user-dummy-token",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.ok) {
    console.log(`created ${EMAIL}`);
  } else if (res.status >= 400 && res.status < 500 && /exist/i.test(text)) {
    console.log(`${EMAIL} already exists`);
  } else {
    console.error(`sign-up failed (status ${res.status}): ${text}`);
    process.exit(1);
  }

  d1(`UPDATE "user" SET "emailVerified" = 1 WHERE email = '${EMAIL}'`);

  const idPayload = d1Json(
    `SELECT id, email, emailVerified FROM user WHERE email = '${EMAIL}'`,
  ) as Array<{ results: Array<{ id: string }> }>;
  const userId = idPayload[0]?.results?.[0]?.id;
  if (!userId) {
    console.error("could not resolve user id");
    process.exit(1);
  }

  d1(
    `INSERT OR REPLACE INTO subscription (id, plan, referenceId, status) VALUES ('local-paid-mock', 'unlimited', '${userId}', 'active')`,
  );

  const check = d1Json(
    `SELECT s.plan, s.status, u.email FROM subscription s JOIN user u ON u.id = s.referenceId WHERE u.email = '${EMAIL}'`,
  );
  console.log(JSON.stringify(check, null, 2));
  console.log(
    `\nSign in at http://localhost:8787\n  email: ${EMAIL}\n  password: ${PASSWORD}\n  plan: unlimited (comped)`,
  );
}

await main();
