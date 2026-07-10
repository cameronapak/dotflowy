#!/bin/bash
#
# WorktreeRemove hook. Fires when Claude Code tears a worktree down (session
# exit, or a subagent finishing). It has no decision control -- exit codes and
# output are ignored, and removal proceeds regardless -- so this is purely for
# side effects.
#
# It runs BEFORE the directory is gone, so it cannot prune the worktree that
# triggered it. What it can do is clear the stale .git/worktrees metadata left
# by *previous* removals, which is what keeps `git worktree list` honest.
set -euo pipefail

input=$(cat)
base=$(jq -r '.base_worktree' <<<"$input")

git -C "$base" worktree prune >&2 || true
exit 0
