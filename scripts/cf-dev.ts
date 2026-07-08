/**
 * cf:dev watch orchestrator.
 *
 * `wrangler dev` reloads the Worker on change but never rebuilds the Vite app,
 * so a production-like single-server preview normally means re-running `build:cf`
 * by hand after every edit. This automates that:
 *
 *   1. an initial `vite build` + copy `_shell.html` -> `index.html` so wrangler
 *      has assets to serve (wrangler errors out if dist/client is missing).
 *   2. `wrangler dev` - serves the built dist/client + the Worker/DO, reading
 *      assets live, so a browser refresh picks up each rebuild with no restart.
 *      It already watches `worker/` itself, so we don't rebuild on worker edits.
 *   3. a recursive watch on `src/` that re-runs the full build on each change
 *      (debounced). The shell points at hashed chunks, so `index.html` MUST be
 *      re-copied each build or it references dead assets. Static Assets serves
 *      `index.html` for `/` and the SPA fallback - see wrangler.jsonc.
 *
 * Why a full `vite build` per change and not `vite build --watch`: watch mode
 * builds the client and ssr environments in parallel, and the SPA prerender
 * (client side) imports `dist/server/server.js` (ssr side) before it's written,
 * so the prerender of `/` 500s. A plain sequential `vite build` avoids that race.
 *
 * Tradeoff: a full build runs per save (~1-2s), slower than `bun run dev`'s HMR.
 * That is the cost of exercising the real Worker + per-user DO path. For pure UI
 * work, `bun run dev` (both servers, HMR) is still the faster loop.
 */
import { watch as fsWatch, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC_DIR = resolve(ROOT, "src");
const CLIENT_DIR = resolve(ROOT, "dist/client");
const SHELL = resolve(CLIENT_DIR, "_shell.html");
const INDEX = resolve(CLIENT_DIR, "index.html");

const log = (msg: string) => console.log(`\x1b[36m[cf:dev]\x1b[0m ${msg}`);

/** Run a full `vite build`, then copy the freshly prerendered shell to index.html. */
async function build(): Promise<boolean> {
  const proc = Bun.spawn(["bunx", "vite", "build"], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) {
    log(`build failed (exit ${code}) - keeping previous dist`);
    return false;
  }
  if (existsSync(SHELL)) {
    copyFileSync(SHELL, INDEX);
    log("copied _shell.html -> index.html");
  }
  return true;
}

// 1. Initial build so wrangler has something to serve.
log("initial build...");
const ok = await build();
if (!ok) {
  log("initial build failed; aborting");
  process.exit(1);
}

// 2. wrangler dev (Worker + per-user DO + serves dist/client live).
log("starting wrangler dev on :8787");
const wrangler = Bun.spawn(["bunx", "wrangler", "dev", "--port", "8787"], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit"],
});

// 3. Rebuild on src/ changes. Debounce the burst of fs events a save produces,
// and never run two builds at once - if edits land mid-build, rebuild once after.
let building = false;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function rebuild(): Promise<void> {
  if (building) {
    dirty = true;
    return;
  }
  building = true;
  log("change detected - rebuilding...");
  await build();
  building = false;
  if (dirty) {
    dirty = false;
    void rebuild();
  }
}

function scheduleRebuild(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 250);
}

fsWatch(SRC_DIR, { recursive: true }, () => scheduleRebuild());
log(`watching src/ for changes (rebuild + reload via wrangler)`);

function teardownAndExit(): void {
  if (timer) clearTimeout(timer);
  wrangler.kill();
  process.exit(0);
}

process.on("SIGINT", teardownAndExit);
process.on("SIGTERM", teardownAndExit);

// If wrangler dies, stop the whole thing so the script doesn't hang.
void wrangler.exited.then(teardownAndExit);
