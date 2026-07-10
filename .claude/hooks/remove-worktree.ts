#!/usr/bin/env bun
//
// WorktreeRemove hook. Fires when Claude Code tears a worktree down (session
// exit, or a subagent finishing). It has no decision control — exit codes and
// output are ignored, and removal proceeds regardless — so this is purely for
// side effects.
//
// Contract (https://code.claude.com/docs/en/hooks#worktreeremove):
//   - stdin  = JSON with `worktree_path` (the worktree being removed) + the
//     common `cwd` field
//   - stdout/exit code are ignored (WorktreeRemove can't block removal)
//
// It runs BEFORE the directory is gone, so it cannot prune the worktree that
// triggered it. What it can do is clear the stale `.git/worktrees` metadata
// left by *previous* removals, which is what keeps `git worktree list` honest.
// Claude Code already runs `git worktree remove` for git worktrees; this prune
// is belt-and-suspenders hygiene for interrupted/manual removals.
let input: { worktree_path?: unknown; cwd?: unknown };
try {
  input = JSON.parse(await Bun.stdin.text());
} catch (err) {
  console.error(`remove-worktree: could not parse stdin JSON: ${err}`);
  // WorktreeRemove can't block, so always exit 0 regardless.
  process.exit(0);
}

// Prefer the documented `worktree_path` (still on disk at hook time, so
// `git -C` resolves its base repo); fall back to the common `cwd`.
const dir =
  typeof input.worktree_path === "string" ? input.worktree_path
  : typeof input.cwd === "string" ? input.cwd
  : undefined;

if (!dir) {
  console.error(
    `remove-worktree: no worktree_path/cwd in input; skipping prune. raw: ${JSON.stringify(input)}`,
  );
  process.exit(0);
}

// `git worktree prune` cleans stale worktree metadata for the repo `dir`
// belongs to. The worktree being removed still exists, so it's spared; only
// entries for already-deleted worktrees (from interrupted past removals) are
// dropped. stdout+stderr go to stderr so nothing pollutes a potential stdout
// contract, and a failure is swallowed (this hook can't block removal).
const proc = Bun.spawn(
  ["git", "-C", dir, "worktree", "prune"],
  { stdin: "ignore", stdout: Bun.file(2), stderr: "inherit" },
);
await proc.exited;

process.exit(0);
