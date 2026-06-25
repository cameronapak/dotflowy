# Cloudflare legacy (pre-Wasp cutover)

The v1 Cloudflare Worker + D1 stack was removed at Phase 4 cutover
(`docs/PRD-wasp-migration.md`). This folder keeps **reference material only**:

| Path | Purpose |
|------|---------|
| `d1-migrations/` | Original D1 SQL schema (nodes + kv tables) |
| `d1-config.json` | Plain JSON: D1 database name + id (for export script) |
| `wrangler.export.jsonc` | Minimal wrangler config for a **one-time remote D1 export** |

## Pre-cutover backup (run once)

Before decommissioning the live D1 database, export a JSON backup:

```sh
# Needs Cloudflare auth (`wrangler login`) and access to the remote D1 DB.
bash scripts/export-d1.sh backups/d1-export.json
```

Retain the JSON file locally (gitignored under `backups/`). It is **not** checked into the repo.

## Import into Wasp / Postgres

After the founder signs up on Railway (or local `wasp start`), import their outline:

```sh
wasp compile   # generates @prisma/client
bun scripts/import-d1-export.ts \
  --file backups/d1-export.json \
  --owner owner \
  --user-email you@example.com
```

Use `--user-id <uuid>` instead of `--user-email` if you already know the Wasp `User.id`.
Pass `--force` to replace an account that already has data (destructive).
