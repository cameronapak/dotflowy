#!/usr/bin/env bash
# Superset workspace setup. Runs on every new workspace creation — keep it fast.
set -euo pipefail

# 1. Install dependencies (bun is the package manager for this repo).
bun install

# 2. Local Worker secrets for `wrangler dev`. Prefer the root repo's real
#    .dev.vars (so the workspace inherits BETTER_AUTH_SECRET etc.); fall back to
#    the checked-in example if the root has none.
if [ ! -f .dev.vars ]; then
  if [ -n "${SUPERSET_ROOT_PATH:-}" ] && [ -f "$SUPERSET_ROOT_PATH/.dev.vars" ]; then
    cp "$SUPERSET_ROOT_PATH/.dev.vars" .dev.vars
    echo "Copied .dev.vars from the root repo."
  else
    cp .dev.vars.example .dev.vars
    echo "Copied .dev.vars.example -> .dev.vars (set BETTER_AUTH_SECRET before using auth)."
  fi
fi

# 3. Apply local D1 migrations (Better Auth identity tables + legacy import
#    source). Idempotent — already-applied migrations are skipped.
bun run db:migrate:local
