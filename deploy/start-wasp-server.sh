#!/usr/bin/env bash
# dotflowy Wasp server launcher (managed by Zo service supervisor)
# Runs Prisma migrations then boots the bundled Express server on :3001.
set -euo pipefail

export PATH="/usr/local/node24/bin:$PATH"
cd "/home/workspace/1. Projects/dotflowy/.wasp/out/server"

# Run migrations (idempotent)
echo "[wasp] Running database migrations…"
DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy --schema="../db/schema.prisma" 2>&1 || {
  echo "[wasp] WARNING: migration step failed, continuing to boot…"
}

echo "[wasp] Starting production server on :3001…"
exec node --enable-source-maps bundle/server.js
