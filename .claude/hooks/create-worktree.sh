#!/bin/bash
#
# WorktreeCreate hook. Replaces Claude Code's default `git worktree add` so a
# new worktree lands dev-ready: deps installed and the local D1 schema applied.
#
# Contract (https://code.claude.com/docs/en/hooks#worktreecreate):
#   - stdin  = JSON with `base_worktree` and `worktree_name`
#   - stdout = the created worktree's path, and NOTHING else
#   - exit 0 = success; any non-zero aborts worktree creation
#
# Everything chatty is redirected to stderr, because stdout IS the return value.
set -euo pipefail

input=$(cat)
base=$(jq -r '.base_worktree' <<<"$input")
name=$(jq -r '.worktree_name' <<<"$input")
path="$base/.claude/worktrees/$name"

{
  # `claude/` prefix matches Claude Code's default branch naming.
  git -C "$base" worktree add -b "claude/$name" "$path" \
    || git -C "$base" worktree add "$path" "claude/$name"

  # .dev.vars is gitignored, so a fresh checkout has no Worker secrets. Copying
  # it before `setup` also preserves BETTER_AUTH_SECRET and INVITE_CODES rather
  # than regenerating them from the template.
  [ -f "$base/.dev.vars" ] && cp "$base/.dev.vars" "$path/.dev.vars"

  cd "$path"

  bun install --frozen-lockfile

  # `bun run setup` requires node_modules, so it must follow the install. It is
  # idempotent, and its wrangler migration prompts on a TTY -- CI=1 plus a
  # closed stdin keep it from blocking forever inside the hook.
  CI=1 bun run setup </dev/null
} >&2

echo "$path"
