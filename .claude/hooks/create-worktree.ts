#!/usr/bin/env bun
//
// WorktreeCreate hook. Replaces Claude Code's default `git worktree add` so a
// new worktree lands dev-ready: deps installed and the local D1 schema applied.
//
// Contract (https://code.claude.com/docs/en/hooks#worktreecreate):
//   - stdin  = JSON with `name` (the worktree slug) + the common `cwd` field
//   - stdout = the created worktree's path, and NOTHING ELSE
//   - exit 0 = success; any non-zero aborts worktree creation
//
// Everything chatty is redirected to stderr, because stdout IS the return value.
import { cpSync, existsSync, readFileSync } from "node:fs";

let input: { name?: unknown; cwd?: unknown };
try {
  input = JSON.parse(await Bun.stdin.text());
} catch (err) {
  console.error(`create-worktree: could not parse stdin JSON: ${err}`);
  process.exit(1);
}

const base = typeof input.cwd === "string" ? input.cwd : undefined;
const name = typeof input.name === "string" ? input.name : undefined;

if (!base || !name) {
  console.error(
    `create-worktree: missing required input (cwd=${base}, name=${name}); raw: ${JSON.stringify(input)}`,
  );
  process.exit(1);
}

const path = `${base}/.claude/worktrees/${name}`;

// Run a command with stdout+stderr sent to stderr (fd 2), so the hook's stdout
// stays clean for the final path echo. stdin is closed so nothing blocks on a
// TTY prompt (the `bun run setup` wrangler migration would otherwise hang).
async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: Bun.file(2), // child stdout → stderr
    stderr: "inherit", // child stderr → stderr
  });
  return proc.exited;
}

try {
  // `claude/` prefix matches Claude Code's default branch naming. Try creating
  // a new branch first; if it already exists, check it out instead.
  const created = await run([
    "git",
    "-C",
    base,
    "worktree",
    "add",
    "-b",
    `claude/${name}`,
    path,
  ]);
  if (created !== 0) {
    const exitCode = await run([
      "git",
      "-C",
      base,
      "worktree",
      "add",
      path,
      `claude/${name}`,
    ]);
    if (exitCode !== 0) throw new Error(`git worktree add exited ${exitCode}`);
  }

  // `.worktreeinclude` is NOT processed by Claude Code once a WorktreeCreate
  // hook replaces the default behavior (per the hook docs), so the hook honors
  // it manually: copy every listed file/dir from the base into the worktree.
  // This carries gitignored secrets like `.dev.vars` (preserving
  // BETTER_AUTH_SECRET / INVITE_CODES rather than regenerating from the
  // template) and shared caches like `.codegraph`.
  const includeFile = `${base}/.worktreeinclude`;
  if (existsSync(includeFile)) {
    const entries = readFileSync(includeFile, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const entry of entries) {
      const src = `${base}/${entry}`;
      if (existsSync(src)) {
        cpSync(src, `${path}/${entry}`, { recursive: true });
      }
    }
  }

  const installExit = await run(["bun", "install", "--frozen-lockfile"], {
    cwd: path,
  });
  if (installExit !== 0) throw new Error(`bun install exited ${installExit}`);

  // `bun run setup` requires node_modules, so it must follow the install. It is
  // idempotent, and its wrangler migration prompts on a TTY — CI=1 plus a closed
  // stdin keep it from blocking forever inside the hook.
  const setupExit = await run(["bun", "run", "setup"], {
    cwd: path,
    env: { ...process.env, CI: "1" },
  });
  if (setupExit !== 0) throw new Error(`bun run setup exited ${setupExit}`);
} catch (err) {
  console.error(`create-worktree: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// stdout = the created worktree path, and nothing else.
console.log(path);
