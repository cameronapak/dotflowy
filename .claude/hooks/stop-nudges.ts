#!/usr/bin/env bun
//
// Stop hook. Fires when a Claude Code session stops and prints up to two
// independently-gated, NON-BLOCKING nudges based on what the session's git
// diff touched:
//
//   1. Docs freshness (#208): substantive source (`src/**`/`worker/**`)
//      changed but neither AGENTS.md nor README.md did — remind the agent to
//      reconcile the docs per AGENTS.md's Documentation Freshness rule.
//   2. End-of-session validation (#213): substantive source changed at all —
//      remind the agent to run the validation set in CONTRIBUTING.md's
//      "Before you open a PR" (the command gates + the run-the-app step).
//      The list itself lives in the doc, not here.
//
// Contract (https://code.claude.com/docs/en/hooks#stop):
//   - stdin  = JSON with the common `cwd` field (+ session fields we ignore)
//   - stdout = optional JSON; `{"systemMessage": "..."}` surfaces a warning
//     to the user WITHOUT blocking the stop
//   - exit 0 always. This hook is a nudge, never a gate: no exit 2, no
//     `{"decision":"block"}`. Any error (bad stdin, not a git repo, git
//     failure) = silent exit 0.
//
// Detection is git-based, not a watcher: the session's footprint is the
// working tree vs HEAD (staged + unstaged + untracked) PLUS whatever the
// branch already committed past its merge-base with the default branch — so
// a session that commits as it goes still gets nudged. Test-only
// (`*.test.ts`) and generated-only (`src/routeTree.gen.ts`) diffs don't
// count as substantive; neither does `e2e/**` (outside src/worker).
//
// Claude-harness-only by design: Codex has no Stop seam (the same asymmetry
// as WorktreeRemove).

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

function lines(out: string | null): string[] {
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function isSubstantiveSource(path: string): boolean {
  if (!path.startsWith("src/") && !path.startsWith("worker/")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path === "src/routeTree.gen.ts") return false;
  return true;
}

function isDoc(path: string): boolean {
  return path === "AGENTS.md" || path === "README.md";
}

try {
  let cwd = process.cwd();
  try {
    const input: { cwd?: unknown } = JSON.parse(await Bun.stdin.text());
    if (typeof input.cwd === "string") cwd = input.cwd;
  } catch {
    // No/bad stdin (e.g. run by hand): fall back to process.cwd().
  }

  const root = lines(await git(cwd, ["rev-parse", "--show-toplevel"]))[0];
  if (!root) process.exit(0); // not a git repo — nothing to nudge about

  const changed = new Set<string>();

  // Working tree vs HEAD: staged + unstaged in one call, then untracked.
  for (const p of lines(await git(root, ["diff", "--name-only", "HEAD"]))) {
    changed.add(p);
  }
  for (const p of lines(
    await git(root, ["ls-files", "--others", "--exclude-standard"]),
  )) {
    changed.add(p);
  }

  // Committed on this branch: diff against the merge-base with the default
  // branch. Try origin/main, then local main; if neither resolves (no
  // remote, shallow clone, detached odd state), skip this half gracefully —
  // the working-tree half above still nudges on uncommitted work.
  for (const ref of ["origin/main", "main"]) {
    const mergeBase = lines(await git(root, ["merge-base", "HEAD", ref]))[0];
    if (!mergeBase) continue;
    for (const p of lines(
      await git(root, ["diff", "--name-only", `${mergeBase}..HEAD`]),
    )) {
      changed.add(p);
    }
    break;
  }

  const paths = [...changed];
  const touchedSubstantiveSource = paths.some(isSubstantiveSource);
  const touchedDocs = paths.some(isDoc);

  const nudges: string[] = [];
  if (touchedSubstantiveSource && !touchedDocs) {
    nudges.push(
      "Docs freshness: this session changed src/ or worker/ but neither AGENTS.md nor README.md. If repo reality changed (structure, paths, commands, tooling, workflow constraints), reconcile the docs per the Documentation Freshness rule in AGENTS.md.",
    );
  }
  if (touchedSubstantiveSource) {
    nudges.push(
      'Validation: this session changed src/ or worker/. Before calling it done, run the end-of-session validation set in CONTRIBUTING.md ("Before you open a PR"), including running the app to confirm observable behavior, not just green gates.',
    );
  }

  if (nudges.length > 0) {
    console.log(JSON.stringify({ systemMessage: nudges.join("\n\n") }));
  }
} catch {
  // Never block a stop: swallow everything.
}

process.exit(0);

// Empty export needed to avoid "export not found" errors
// as well as top-level await errors
export {};
