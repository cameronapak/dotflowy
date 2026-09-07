/**
 * E2e webServer command (ADR 0061): prod-parity, self-booted.
 *
 *   1. `vite build` + copy `_shell.html` -> `index.html` (the build:cf steps)
 *      so wrangler has the real SPA to serve - no Vite dev server, no proxy.
 *   2. `wrangler d1 migrations apply --local` (idempotent) so the Worker's
 *      D1 is ready before it boots.
 *   3. `wrangler dev --port $E2E_PORT` - ONE origin serving SPA + Worker +
 *      DOs, exactly as production does. Playwright polls the port for
 *      readiness, then e2e/global-setup.ts signs up the run's user through
 *      the real HTTP signup (the stack's doctor).
 *
 * Killing this script (Playwright tears the webServer down with SIGTERM)
 * kills wrangler - never the other way around: if wrangler dies, so do we,
 * so a wedged run can't report green.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PORT = process.env.E2E_PORT ?? "3210";
const CLIENT_DIR = resolve(ROOT, "dist/client");
const SHELL = resolve(CLIENT_DIR, "_shell.html");
const INDEX = resolve(CLIENT_DIR, "index.html");

const log = (msg: string) => console.log(`\x1b[36m[e2e-serve]\x1b[0m ${msg}`);

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((res) => {
    const proc = spawn(cmd, args, {
      cwd: ROOT,
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...process.env,
        // Never prompt about telemetry mid-run; CI and local behave alike.
        WRANGLER_SEND_METRICS: "false",
      },
    });
    proc.on("exit", (code) => res(code ?? 1));
  });
}

// 1. Build the SPA exactly as `build:cf` does.
log(`building SPA (vite build)...`);
const buildCode = await run("bunx", ["vite", "build"]);
if (buildCode !== 0) {
  log("build failed; aborting");
  process.exit(1);
}
if (existsSync(SHELL)) {
  copyFileSync(SHELL, INDEX);
  log("copied _shell.html -> index.html");
}

// 2. Local D1 migrations (idempotent; same state dir wrangler dev uses).
log("applying local D1 migrations...");
const migrateCode = await run("bunx", [
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "dotflowy-db",
  "--local",
]);
if (migrateCode !== 0) {
  log("migrations failed; aborting");
  process.exit(1);
}

// 3. One origin: wrangler serves the built SPA AND the Worker + DOs.
log(`starting wrangler dev on :${PORT}`);
const wrangler = spawn("bunx", ["wrangler", "dev", "--port", PORT], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit"],
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
  },
});

function teardownAndExit(): void {
  wrangler.kill();
  process.exit(0);
}

process.on("SIGINT", teardownAndExit);
process.on("SIGTERM", teardownAndExit);

// If wrangler dies, stop the whole thing so Playwright fails loudly
// instead of testing against a dead origin.
wrangler.on("exit", (code) => {
  log(`wrangler dev exited (code ${code})`);
  process.exit(code ?? 1);
});
