#!/usr/bin/env bash
# Superset Run button: the dotflowy dev loop.
# The SPA (vite, :3000) proxies /api -> the Worker (wrangler dev, :8787), so
# BOTH servers must run. This starts the Worker in the background and Vite in
# the foreground; closing the pane (or Vite exiting) tears the Worker down too.
set -euo pipefail

bun run dev:api &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT INT TERM

bun run dev
