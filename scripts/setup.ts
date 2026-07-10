/**
 * `bun run setup` bootstraps a fresh clone into a working local dev config.
 *
 * Three steps, each idempotent:
 *   1. Copy `.dev.vars.example` -> `.dev.vars` if it doesn't exist yet.
 *   2. Generate a `BETTER_AUTH_SECRET` if it's still the template placeholder
 *      (or empty) - never rotate an already-set secret.
 *   3. Apply the local D1 schema via the existing `db:migrate:local` script
 *      (wrangler's migration apply is itself idempotent - re-running is a
 *      no-op).
 *   4. Warm the opensrc cache with the Effect v4 source (ADR 0040) so agents
 *      can read it offline. Failure-tolerant: setup must not die because
 *      GitHub was unreachable.
 *
 * Safe to re-run any time; never prints the generated secret.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DEV_VARS = resolve(ROOT, ".dev.vars");
const DEV_VARS_EXAMPLE = resolve(ROOT, ".dev.vars.example");
const NODE_MODULES = resolve(ROOT, "node_modules");

const log = (msg: string) => console.log(`\x1b[36m[setup]\x1b[0m ${msg}`);

if (!existsSync(NODE_MODULES)) {
  log("node_modules missing - run `bun install` first");
  process.exit(1);
}

// 1. Ensure .dev.vars exists.
if (!existsSync(DEV_VARS)) {
  copyFileSync(DEV_VARS_EXAMPLE, DEV_VARS);
  log("created .dev.vars from .dev.vars.example");
} else {
  log(".dev.vars already present - leaving it");
}

// 2. Ensure BETTER_AUTH_SECRET is set (line-oriented rewrite so commented
// optional keys stay untouched).
const lines = readFileSync(DEV_VARS, "utf8").split("\n");
const idx = lines.findIndex((l) => l.startsWith("BETTER_AUTH_SECRET="));
const current = idx >= 0 ? lines[idx].slice("BETTER_AUTH_SECRET=".length) : "";
if (idx >= 0 && (current === "replace-me" || current.trim() === "")) {
  lines[idx] = `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64")}`;
  writeFileSync(DEV_VARS, lines.join("\n"));
  log("generated BETTER_AUTH_SECRET (32 bytes)");
} else {
  log("BETTER_AUTH_SECRET already set - leaving it");
}

// 3. Apply local D1 schema.
log("applying local D1 schema (db:migrate:local)...");
const migrate = Bun.spawn(["bun", "run", "db:migrate:local"], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit"],
});
const code = await migrate.exited;
if (code !== 0) {
  log(`db:migrate:local failed (exit ${code})`);
  process.exit(1);
}

// 4. Warm the opensrc cache with the Effect v4 source (non-fatal).
log("warming the Effect v4 source cache (opensrc)...");
const warm = Bun.spawn(["bunx", "opensrc", "fetch", "Effect-TS/effect-smol"], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit"],
});
if ((await warm.exited) !== 0) {
  log("opensrc fetch failed (offline?) - continuing; it fetches on first use");
}

log("Setup complete. Next:");
log("  bun run dev          # start the app (http://localhost:3000)");
log("  Sign up with invite code: dev-invite");
