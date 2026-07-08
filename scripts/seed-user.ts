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
 */
const API = "http://localhost:8787";
const EMAIL = "dev@dotflowy.local";
const PASSWORD = "dotflowy-dev";
const INVITE = "dev-invite";

async function main(): Promise<void> {
  // Preflight: make sure the Worker is actually up before attempting the
  // real sign-up POST, so a connection-refused doesn't read as an auth error.
  try {
    await fetch(`${API}/api/auth/ok`);
  } catch {
    console.error(
      `Worker not reachable at ${API}. Run \`bun run dev\` first.`,
    );
    process.exit(1);
  }

  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Dev",
      email: EMAIL,
      password: PASSWORD,
      inviteCode: INVITE,
    }),
  });

  if (res.ok) {
    console.log(`created ${EMAIL} (password: ${PASSWORD})`);
  } else {
    const text = await res.text();

    if (res.status >= 400 && res.status < 500 && /exist/i.test(text)) {
      console.log(`${EMAIL} already exists - sign in with password: ${PASSWORD}`);
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
