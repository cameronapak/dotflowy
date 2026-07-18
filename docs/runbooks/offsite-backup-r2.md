# Runbook: off-site outline backups (DO → R2) + snapshot restore

Daily off-platform backups of every user's outline to R2, plus the operator
restore path that reads them back. This is the belt-and-suspenders tier above
the free 30-day Point-in-Time Recovery ([restore-user-pitr.md](./restore-user-pitr.md)):
it answers "older than 30 days" and "the Cloudflare account itself is the blast
radius", and it is what allows the legal pages to claim off-site backups.
Ticket [#221](https://github.com/cameronapak/dotflowy/issues/221), research in
[#155](https://github.com/cameronapak/dotflowy/issues/155).

## How it works

- A **cron trigger** (`0 9 * * *` UTC, `wrangler.jsonc`) runs `runBackupSweep`
  (`worker/index.ts`): `SELECT id FROM "user"` in D1 (the authoritative id set —
  deliberately not the eventually-consistent DO enumeration API), owner mapped to
  the `'default'` DO, then per DO: `exportSnapshot()` RPC → one JSON object in R2.
- **Key layout:** `backups/<doName>/<YYYY-MM-DD>.json` (UTC date). One object per
  DO per day; a same-day re-run overwrites, never duplicates. `<doName>` is the
  DO name (`user.id`, or `default` for the owner-bridge account).
- **Snapshot shape** (`worker/backup.ts`, version-stamped): `{ version,
exportedAt, seq, nodes, kv }`. kv `value`s stay the raw stored JSON TEXT, so a
  restore round-trips the kv table byte-for-byte.
- Per-user failures are contained (try/catch + Sentry + `console.error`); the
  sweep always finishes the list and logs `ok/total` to Workers Logs.
- **Subrequest note:** each user costs ~2 subrequests (DO RPC + R2 put). A cron
  invocation allows 1,000, so this design is fine to roughly ~450 users; shard
  the sweep before then.

## One-time setup (before the first deploy with this change)

```sh
# 1. Create the bucket the binding in wrangler.jsonc points at
bunx wrangler r2 bucket create dotflowy-backups

# 2. Expire snapshots after 90 days (the retention promise: daily granularity,
#    ~90-day depth; PITR covers the fine-grained recent window)
bunx wrangler r2 bucket lifecycle add dotflowy-backups backups-expire-90d --prefix backups/ --expire-days 90
```

Verify: `bunx wrangler r2 bucket lifecycle list dotflowy-backups`.
(Flag names drift across wrangler versions — `bunx wrangler r2 bucket lifecycle add --help` if it complains.)

Then `bun run deploy` as usual. The cron registers with the deploy; confirm under
the Worker's **Settings → Triggers** in the dashboard, and watch the first run in
Workers Logs (`backup sweep: N/N DOs exported`).

## Listing a user's backups

Admin-gated (`ADMIN_EMAILS`, fail-closed, 404 for non-admins — same gate as the
PITR restore). Signed in as an admin:

```sh
curl -s -b "$COOKIES" "https://app.dotflowy.com/api/admin/backups?email=user@example.com"
# → { "doName": "...", "backups": [{ "key": "backups/<id>/2026-07-17.json", "size": ..., "uploaded": "..." }] }
```

Or straight from R2: `bunx wrangler r2 object get dotflowy-backups backups/<doName>/<date>.json --pipe`.

## Restoring a user from a snapshot

**Destructive**: replaces the user's entire outline (nodes + side-collections)
with the snapshot's contents, in one transaction. The response includes
`previousBookmark` — the pre-restore PITR handle. **Save it**: the undo path is
the existing PITR route with that bookmark
(`POST /api/admin/restore {"userId": ..., "bookmark": ...}`).

```sh
curl -s -b "$COOKIES" -X POST "https://app.dotflowy.com/api/admin/restore-snapshot" \
  -H 'content-type: application/json' \
  -d '{"email": "user@example.com", "date": "2026-07-17"}'
# → { "key": "...", "previousBookmark": "...", "nodes": 4896, "kv": 152 }
```

Exactly one of `userId` / `email`, like the PITR route. Live tabs are kicked
(~1s deferred `ctx.abort`) and reconnect straight into a fresh snapshot — the
seq is bumped and the changelog emptied, so no client can "resume" a stale view.

Prefer the PITR restore whenever the loss is inside the 30-day window (finer
granularity — any minute, not one snapshot per day); use this path for older
losses or anything that outlived the PITR window.

### Known limits (accepted for beta)

- **Coordinate with the user before restoring.** The restored data is live at
  commit, but stale tabs stay connected for ~1s until the deferred abort — an
  edit the user makes in that window lands ON TOP of the restored outline and
  persists (unlike the PITR path, where the restart wipes it). Restore while
  the user isn't actively editing.
- **The restore bypasses the free-tier node cap** (like the PITR restore — an
  operator escape hatch). Restoring a large snapshot into a free account can
  leave it over the cap: nothing locks (edits/deletes still work, per #170),
  but net-growth writes 403 until the user prunes or upgrades. Say so when you
  hand the account back.
- **One snapshot = one RPC message**, capped at 32 MiB serialized. An outline
  past that ceiling fails its nightly export (caught + reported to Sentry every
  night — watch for a recurring `backup sweep: export failed for DO …`) and a
  chunked export path would need building. Far above today's outlines; the
  Sentry noise is the tripwire.
- **Old snapshots must keep decoding.** The restore path validates against the
  shared `NodeSchema`; when a new required `Node` field lands, the snapshot
  boundary needs a backfill (or a `SNAPSHOT_VERSION` bump) or every pre-change
  snapshot in the 90-day depth becomes unrestorable — this is on the
  new-`Node`-field checklist in AGENTS.md.

## Local dev / verification

Everything except PITR bookmarks works locally (miniflare simulates R2 on disk,
`previousBookmark` may come back `null`):

```sh
bunx wrangler dev --test-scheduled   # serves :8787 + the manual cron hook
curl "http://localhost:8787/__scheduled?cron=0+9+*+*+*"   # fire the sweep
```

Then list what landed: `bunx wrangler r2 object get` against the local
simulator, or just watch the `backup sweep: N/N DOs exported` log line. The
restore route is fully drivable locally (seed a user with `bun run seed:user`,
edit, back up, edit again, restore, reload).
