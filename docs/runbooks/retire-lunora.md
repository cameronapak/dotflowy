# Retire Lunora per user

This is the release 1 operator runbook for [ADR 0061](../adr/0061-retire-lunora-through-per-user-cutover.md). It installs migration tooling only. Do not remove the Lunora binding, shard data, D1 records, or R2 snapshots during the observation period.

## Before running

1. Deploy the Worker code and apply `migrations/0010_lunora_retirement.sql` to D1 through the normal deployment migration step.
2. Keep the `BACKUPS` R2 binding. Retirement objects use `lunora-retirement/`, outside the `backups/` lifecycle prefix.
3. Authenticate with `DOTFLOWY_ADMIN_EMAIL` plus `DOTFLOWY_ADMIN_PASSWORD`, or set `DOTFLOWY_SESSION_COOKIE` to a current admin cookie.
4. Start with a report and dry run. Do not use `--execute` until every classification has been reviewed.

The CLI defaults to production. Pass `--api` for local or staging work. Credential-bearing requests accept only HTTPS `dotflowy.com` origins or HTTP(S) loopback origins, and never follow redirects.

## Classify

```sh
bun run lunora:retire                         # dry-run every Better Auth user
bun run lunora:retire dry-run --user USER_ID
bun run lunora:retire report --all --out retirement-report.json
```

The D1 `user` table supplies the authoritative population. Automatic migration is limited to `eligible`. `already-classic` needs no write. `backend-conflict`, `classic-invalid`, `incomplete`, and `invalid` require manual review.

Reports contain user ids, states, collection counts, hashes, snapshot keys, timestamps, and failure reasons. They never contain node text.

## Migrate

```sh
bun run lunora:retire migrate --user USER_ID --execute
bun run lunora:retire migrate --all --execute
```

`--all` is sequential. It dry-runs each user and sends a migration request only for `eligible` users. Each request freezes and backs up classic first, then freezes and backs up Lunora, reads and hashes both R2 objects, restores and verifies classic, retires Lunora, and finally unfreezes classic.

Do not interrupt a request deliberately. If a request is interrupted, retry the same user. The durable migration id is reused.

```sh
bun run lunora:retire retry --user USER_ID --execute
bun run lunora:retire status --user USER_ID
```

`completed` is an idempotent no-op. `uncertain` remains frozen and requires operator recovery. Do not bypass either backend's fence.

## Restore the pre-migration classic snapshot

Use this only when the recorded immutable classic object and hash are present:

```sh
bun run lunora:retire restore --user USER_ID --execute
```

The operation reads, decodes, and hashes the R2 object, restores it under the matching classic fence, verifies semantic equality, then releases safe fences. If Lunora is already retired, the restored classic content keeps the Lunora preference disabled so clients and MCP stay on classic. If verification or fence release fails, the record remains `uncertain` and classic remains frozen.

## Observation period

The 30-day observation period starts only after every user is either `completed` or confirmed `already-classic`, with no failed or manual-review classifications outstanding. Runtime removal, binding removal, shard deletion, and retirement snapshot deletion belong to later releases and require separate approval.
