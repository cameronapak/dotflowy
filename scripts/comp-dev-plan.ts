/**
 * Operator-comp an active unlimited subscription for the local dev account
 * (`dev@dotflowy.local`) in local D1 — the same pattern documented in
 * worker/plan.ts (hand-inserted row, no Stripe ids). MCP tool calls require a
 * paid plan (#170); this keeps local dogfood off the production entitlement gate.
 *
 * Idempotent: re-running is a no-op when an active/trialing row already exists.
 * Localhost-only: resolves the user from the live Worker session, never accepts
 * an email override (no accidental prod targeting).
 *
 * Requires `bun run dev` / `bun run dev:api` and a seeded dev account
 * (`bun run seed:user`).
 */
const API = "http://localhost:8787";
const EMAIL = "dev@dotflowy.local";
const PASSWORD = "dotflowy-dev";
const ORIGIN = "http://localhost:8787";
const SUBSCRIPTION_ID = "local-dev-unlimited-comp";

async function signInUserId(): Promise<string> {
  const res = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `sign-in failed (${res.status}): ${text}. Run \`bun run seed:user\` first.`,
    );
  }
  const body = (await res.json()) as { user?: { id?: string } };
  const userId = body.user?.id;
  if (!userId) throw new Error("sign-in succeeded but user id missing");
  return userId;
}

function compSubscription(userId: string): void {
  const proc = Bun.spawnSync(
    [
      "wrangler",
      "d1",
      "execute",
      "dotflowy-db",
      "--local",
      "--command",
      `INSERT OR IGNORE INTO subscription (id, plan, referenceId, status) VALUES ('${SUBSCRIPTION_ID}', 'unlimited', '${userId}', 'active')`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr);
    throw new Error(
      `wrangler d1 execute failed (exit ${proc.exitCode}): ${err}`,
    );
  }
}

async function main(): Promise<void> {
  try {
    await fetch(`${API}/api/auth/ok`);
  } catch {
    console.error(`Worker not reachable at ${API}. Run \`bun run dev\` first.`);
    process.exit(1);
  }

  const userId = await signInUserId();
  compSubscription(userId);
  console.log(`comped unlimited plan for ${EMAIL} (${userId}) in local D1`);
}

await main();
