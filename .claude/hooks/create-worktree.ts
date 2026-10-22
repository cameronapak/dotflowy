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
//
// The dev-ready half (copy `.worktreeinclude`, install, setup) lives in
// `scripts/bootstrap.ts` so the Codex app's worktree setup script
// (`.codex/environments/environment.toml`) runs the exact same steps. Only the
// `git worktree add` below is Claude-specific: Codex creates its own worktree
// before running its setup script.

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
  // hook replaces the default behavior (per the hook docs). `bootstrap.ts`
  // honors it manually, then installs deps and runs setup.
  //
  // Deliberately the BASE repo's copy, run with cwd set to the new worktree:
  // `bootstrap.ts` targets the checkout that owns its cwd, so a worktree
  // branched off a commit that predates the script still bootstraps. Shelling
  // into `${path}/scripts/bootstrap.ts` would abort worktree creation there.
  //
  // `bun` runs it straight from source, before any install: it imports only
  // node builtins.
  const bootstrapExit = await run(["bun", `${base}/scripts/bootstrap.ts`], {
    cwd: path,
  });
  if (bootstrapExit !== 0) {
    throw new Error(`bootstrap exited ${bootstrapExit}`);
  }
} catch (err) {
  console.error(`create-worktree: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// stdout = the created worktree path, and nothing else.
console.log(path);
