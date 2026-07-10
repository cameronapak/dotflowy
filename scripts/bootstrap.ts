/**
 * `bun run bootstrap` makes the current checkout dev-ready, wherever it came
 * from: a fresh clone, a Claude Code worktree, or a Codex app worktree.
 *
 * It is the harness-agnostic half of what the `WorktreeCreate` hook used to do
 * inline. Both harnesses now call this one script, so their bootstrap can't
 * drift:
 *   - Claude Code  -> `.claude/hooks/create-worktree.ts` (after `git worktree add`)
 *   - Codex app    -> `.codex/environments/environment.toml` `[setup] script`
 *   - a bare clone -> a human typing `bun run bootstrap`
 *
 * Three steps, each idempotent:
 *   1. Copy every `.worktreeinclude` entry from the BASE repo into this
 *      checkout. Carries gitignored files a worktree can't inherit from git
 *      (`.dev.vars` secrets, the `.codegraph` cache). No-op in a plain clone,
 *      where the base repo IS this checkout.
 *   2. `bun install --frozen-lockfile`.
 *   3. `bun run setup` (`.dev.vars` + BETTER_AUTH_SECRET + local D1 schema).
 *
 * Both roots are derived from the CURRENT DIRECTORY, never from this file's
 * location and never passed in:
 *   - Targeting cwd (not `import.meta.dir`) lets the `WorktreeCreate` hook run
 *     the BASE repo's copy of this script against a brand-new worktree. That
 *     matters: a worktree branched off an old commit may not contain
 *     `scripts/bootstrap.ts` at all, and a hook that shelled into the
 *     worktree's own copy would abort worktree creation outright.
 *   - Neither harness injects a path to the base repo (see openai/codex#13576),
 *     so `git rev-parse --git-common-dir` is the only portable way to find it.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const log = (msg: string) => console.log(`\x1b[36m[bootstrap]\x1b[0m ${msg}`);

/** `git rev-parse <flag>`, as an absolute path, resolved from `cwd`. */
async function gitPath(flag: string, cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--path-format=absolute", flag], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`not a git repository: ${cwd}`);
  }
  return (await new Response(proc.stdout).text()).trim();
}

/** The checkout being bootstrapped: the worktree/clone that owns `cwd`. */
const ROOT = await gitPath("--show-toplevel", process.cwd());

/**
 * The main repo `ROOT` belongs to; equals `ROOT` outside a worktree.
 * `--git-common-dir` is `<base>/.git` in both a clone and a linked worktree,
 * so its parent is the base working tree either way.
 */
const BASE = dirname(await gitPath("--git-common-dir", ROOT));

/** Run a command in `ROOT`, inheriting stdio. Returns its exit code. */
async function run(
  cmd: string[],
  env?: Record<string, string | undefined>,
): Promise<number> {
  // stdin closed so nothing blocks on a TTY prompt when this runs unattended
  // inside a harness hook.
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  return proc.exited;
}

/**
 * A live CodeGraph daemon keeps its runtime state inside the `.codegraph`
 * cache it serves. That state is bound to ONE checkout and must never be
 * copied into another: `daemon.pid` names the base repo's pid and socket path,
 * so a worktree that inherits it points its client at the base repo's daemon
 * and reads the wrong tree. `daemon.sock` can't be copied at all.
 */
const DAEMON_STATE = new Set(["daemon.sock", "daemon.pid", "daemon.log"]);

/**
 * `cpSync` copies only regular files, directories, and symlinks; every other
 * inode type aborts the whole walk (node throws `ERR_FS_CP_SOCKET`, bun the
 * raw `ENOTSUP` from `copyfile(2)`). Filtering runs before that check, so
 * rejecting them here keeps a running daemon's socket from failing bootstrap.
 */
function isCopyable(src: string): boolean {
  if (DAEMON_STATE.has(basename(src))) return false;
  const stat = lstatSync(src, { throwIfNoEntry: false });
  if (!stat) return false;
  return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
}

log(`bootstrapping ${ROOT}`);

// 1. Carry gitignored files the base repo has and a fresh worktree can't.
const includeFile = resolve(BASE, ".worktreeinclude");

if (BASE === ROOT) {
  log("not a worktree - skipping .worktreeinclude copy");
} else if (!existsSync(includeFile)) {
  log("no .worktreeinclude in the base repo - nothing to copy");
} else {
  const entries = readFileSync(includeFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  for (const entry of entries) {
    const src = resolve(BASE, entry);
    const dest = resolve(ROOT, entry);
    if (!existsSync(src)) {
      log(`${entry}: absent in the base repo - skipping`);
      continue;
    }

    const existed = existsSync(dest);
    mkdirSync(dirname(dest), { recursive: true });

    // `force: false` fills in what's missing and never overwrites what's there.
    // Both halves matter. A re-run must not clobber a secret this worktree
    // already generated (`.dev.vars`), and a directory that git already
    // materialized must still receive the rest of its contents: `.codegraph/`
    // is gitignored except for one tracked `.gitignore`, so a fresh worktree
    // starts with the directory present but the 164MB cache absent. An
    // exists-check on the directory would silently skip the whole cache.
    cpSync(src, dest, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: isCopyable,
    });
    log(
      existed
        ? `${entry}: already here - filled in anything missing`
        : `${entry}: copied from the base repo`,
    );
  }
}

// 2. Install deps. `bun run setup` needs node_modules, so this must come first.
log("installing dependencies...");
const installExit = await run(["bun", "install", "--frozen-lockfile"]);
if (installExit !== 0) {
  log(`bun install failed (exit ${installExit})`);
  process.exit(1);
}

// 3. Configure the local dev environment. `CI=1` keeps wrangler's migration
// from prompting when this runs unattended inside a harness hook.
log("running setup...");
const setupExit = await run(["bun", "run", "setup"], {
  ...process.env,
  CI: "1",
});
if (setupExit !== 0) {
  log(`bun run setup failed (exit ${setupExit})`);
  process.exit(1);
}

log("Bootstrap complete.");
