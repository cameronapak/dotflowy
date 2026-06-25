#!/usr/bin/env bash
# dotflowy PostgreSQL launcher (managed by Zo service supervisor)
# Runs Postgres 15 on 127.0.0.1:5432, socket in /tmp (avoids /var/run perms).
set -euo pipefail

PGBIN="/usr/lib/postgresql/15/bin"
PGDATA="/home/workspace/1. Projects/dotflowy/.pgdata"
DB_NAME="dotflowy"
DB_USER="dotflowy"

# One-time init
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "[pg] Initializing data directory…"
  mkdir -p "$PGDATA"
  chown -R nobody:nogroup "$PGDATA"
  su nobody -s /bin/bash -c "$PGBIN/initdb -D '$PGDATA' -U '$DB_USER' --auth=trust"
fi

chown -R nobody:nogroup "$PGDATA"

# Start (foreground so the supervisor can track it)
# -- Prefixes the postgres log lines so they're readable in /dev/shm logs.
exec su nobody -s /bin/bash -c "exec $PGBIN/postgres -D '$PGDATA' -c listen_addresses='127.0.0.1' -c unix_socket_directories='/tmp'"
