/**
 * `bun run dev` orchestrator: starts BOTH local servers with one command.
 *
 * Dotflowy's dev loop is two servers: `wrangler dev` (Worker + per-user DO +
 * local D1) on :8787, and Vite (the SPA) on :3000, which proxies `/api` to
 * :8787 (see vite.config.ts). Previously `bun run dev` only started Vite, so
 * a new contributor running just that command got a UI where every `/api`
 * call 502s with no explanation. This spawns both, prefixes their output,
 * and tears both down together on exit.
 *
 * This is the HMR loop (fast, no rebuild-per-save) - not `cf:dev`
 * (scripts/cf-dev.ts), which is a slower production-like single-server
 * preview that exercises the real built assets through wrangler.
 */
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const log = (msg: string) => console.log(`\x1b[36m[dev]\x1b[0m ${msg}`);

log("starting wrangler dev on :8787 + vite dev on :3000 ...");

const wrangler = Bun.spawn(["bunx", "wrangler", "dev", "--port", "8787"], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit"],
});

// Forward any extra CLI args (e.g. `bun run dev --port 3005`) to vite.
const vite = Bun.spawn(["bunx", "vite", "dev", ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit"],
});

log("Worker: http://localhost:8787  |  App: http://localhost:3000");

function teardownAndExit(): void {
  wrangler.kill();
  vite.kill();
  process.exit(0);
}

process.on("SIGINT", teardownAndExit);
process.on("SIGTERM", teardownAndExit);

// If either child dies on its own, tear down the other so the script never
// hangs with an orphaned process.
void wrangler.exited.then(teardownAndExit);
void vite.exited.then(teardownAndExit);
