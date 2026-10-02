# Retire Lunora per user

This is the release 1 operator runbook for [ADR 0061](../adr/0061-retire-lunora-through-per-user-cutover.md). It installs migration tooling only. Do not remove the Lunora binding, shard data, D1 records, or R2 snapshots during the observation period.

## Local verification

Run the isolated checks with `bun run test:e2e:retirement`. They exercise Workerd, SQLite Durable Objects, D1, and R2 without production bindings. They cover sequential cutover, recovery, overlapping request rejection, retained operation claims, CLI batch stopping, and live outline and retirement shape delivery. These checks do not exercise the browser's automatic reload.

Also exercise a disposable local account with the app running: enable upgraded sync, confirm its nodes appear, keep that browser open while an admin migrates it, and confirm the browser switches to classic with the same nodes. The Lunora app must enable `.cdc()`; without it, the socket upgrades but refuses both outline and retirement shapes with `SHAPE_REQUIRES_CDC`.

## Before running

1. Obtain approval to apply the missing retirement migrations (`0010_lunora_retirement.sql`, `0011_lunora_retirement_operation_claim.sql`, and `0013_preserve_classic_retirement.sql`) to production D1, then deploy the Worker code. Migration 0012 belongs to the separate consent release; it is not required here. Apply only explicitly approved missing migrations. Do not assume deployment applies them or migrates users.
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

Inspect every user's Lunora snapshot, including users whose preference is off. Current opt-ins and the number of allocated shards do not establish which accounts contain Lunora data. Dry-run writes migration metadata and attempt records to D1, even though it does not replace outline content; obtain production-write approval before running it remotely.

Reports contain user ids, states, collection counts, hashes, snapshot keys, timestamps, and failure reasons. They never contain node text.

## Compare a manual-review account without writing

Use `GET /api/admin/lunora-retirement?diagnostic=1&userId=REVIEWED_USER_ID`
to compare one account's current classic and experimental snapshots. You can
provide `email` instead of `userId`, but not both. The server checks the admin
session before resolving the target; anonymous and non-admin callers receive 404. Responses use `Cache-Control: private, no-store`.

In a signed-in admin tab in desktop Chrome or Edge, run this in the console:

```js
const response = await fetch(
  "/api/admin/lunora-retirement?" +
    new URLSearchParams({ diagnostic: "1", userId: "REVIEWED_USER_ID" }),
  { credentials: "same-origin", cache: "no-store" },
);
if (!response.ok) throw new Error(`Diagnostic failed: HTTP ${response.status}`);
const report = await response.json();
console.log(report);
copy(JSON.stringify(report, null, 2));
```

The diagnostic reports the saved preference as enabled, disabled, missing, or
invalid. It returns graph validation, missing-reference ids and their presence
in the other backend, node counts, backend-only ids, changed-field names, and
side-collection difference counts. It excludes node text, tag names, colors,
query names, query expressions, and content hashes. ID and changed-field samples
are capped at 50; their counts cover the full snapshots. Duplicate node ids or
malformed or duplicate side-collection rows make the affected comparison
unavailable (`comparable: false`, difference totals `null`).

This request does not seed or heal data, freeze writes, create audit records or
backups, change preferences, repair references, or migrate the account. It reads
the backends separately while edits may continue. The read and export timestamps
describe the comparison window, not which backend has newer content. Finding a
missing parent in classic does not authorize copying it into experimental.
Keep migration checks strict and review the report before proposing any repair
or source choice. Do not enable experimental sync to inspect a blocked account;
client startup can import or heal data.

## Migrate

```sh
bun run lunora:retire migrate --user USER_ID --execute
bun run lunora:retire migrate --all --execute
```

`--all` is sequential. It dry-runs each user and sends a migration request only for `eligible` users. Each request freezes and backs up classic first, then freezes and backs up Lunora, reads and hashes both R2 objects, restores and verifies classic, retires Lunora, and finally unfreezes classic.

Start with one reviewed pilot user. Compare the restored nodes and all three shared side-collections with the frozen source, and check classic-only preferences. Proceed sequentially only after that verification. `migrate --all` skips completed and confirmed already-classic users, stops on the first conflict, uncertain state, or incomplete migration, and exits nonzero. Review its report before continuing.

Do not interrupt a request deliberately. Before retrying an interrupted request, confirm the original executor has stopped. The durable migration id is reused.

```sh
bun run lunora:retire retry --user USER_ID --execute
bun run lunora:retire status --user USER_ID
```

For sequential requests, completed dry-runs and retries are no-ops. An uncertain dry-run or retry preserves the record and fences; explicit operator recovery is required. Other dry-runs inspect content without resetting an existing migration lifecycle. Do not bypass either backend's fence.

Browsers opened before this release may lack the retirement subscription. The retired shard rejects their writes, but they may need a reload to pick up classic. Verify that a fresh load uses classic; do not reopen Lunora to accommodate an old client.

Enabled accounts still receive their complete validated experimental outline and shared side-collections, not a recovery folder. Both complete snapshots remain archived, including a raw experimental envelope at `<lunoraSnapshotKey>.archive` whose hash appears in `counts.rawArchiveHash`. Invalid or conflicting enabled accounts stay blocked for individual review.

Rollback can reopen writes. If fresh frozen classic or Lunora content differs from the immutable backup, retry refuses to restore and reports `operator review required`. This includes preferences, shared side-collections, and migration watermarks. Review both current backends and retained backups; do not delete or replace the immutable objects to force a retry. Unchanged re-exports may differ in export timestamps or row order.

## Preserve an explicitly chosen Classic outline

Use this only for one reviewed user who has explicitly disabled experimental sync and chosen to keep Classic. Obtain approval for that user's production operation. Enabled users are rejected; the toggle alone is not evidence that either backend contains every newer edit.

```sh
bun run lunora:retire preserve-classic --user REVIEWED_USER_ID --execute
bun run lunora:retire report --user REVIEWED_USER_ID
```

This freezes both backends, verifies complete immutable Classic and raw experimental archives, and saves a private recovery manifest. Classic nodes and KV remain unchanged. Missing experimental graph references remain in the archive; only detached recovery copies adapt them. A receipt binds the archives before experimental writes are permanently retired and Classic reopens. Confirm `state: completed`, `result: classic-preserved`, both archive hashes, and `recoveryManifestHash`; check that fresh browser and MCP reads use Classic and editing still works.

Review `counts.recovery`: experimental-only nodes, substantive alternatives, archived metadata-only differences, copy count, structure adaptations, and link outcomes. The admin response does not return outline text or the content-bearing manifest. Experimental side-collections remain archived and never replace Classic's collections.

The additive recovery import is optional and separately approved. Pass the exact reviewed hash, not a newly fetched value that silently authorizes a different plan:

```sh
bun run lunora:retire recover-classic --user REVIEWED_USER_ID --manifest-hash REVIEWED_HASH --execute
```

This atomically appends **Recovered experimental content** to the current Classic root tail, using persisted fresh ids. Verify the folder, selected text/task alternatives, adapted placement, and inert mirror placeholders. Existing Classic nodes and side-collections remain unchanged. Repeated requests return the import receipt without overwriting edited copies or recreating deleted ones. Missing/corrupt archives or manifests and current-id collisions reject the import without partial writes.

Neither manual operation accepts `--all`. A lost response is not permission to start another executor or clear its claim. After confirming the invocation stopped and following exact-token claim recovery below, `retry` can finish a preserve operation with a receipt without restoring old content. Before preservation commits, a safely failed operation releases both fences. If edits invalidate its archive, obtain approval for a new reviewed `preserve-classic` revision; the old objects and attempts remain. Never use `migrate`, `restore`, generic snapshot replacement, or PITR to overwrite preserved Classic. Generic snapshot replacement and PITR are blocked after permanent retirement; explicit automatic-policy rollback is not a manual-preservation recovery tool.

## Recover an interrupted operation claim

Every operation, including dry-run and restore, holds a durable D1 claim distinct from the migration id. Overlapping requests return 409 with `retirement_operation_in_progress`, without calling either backend. Reports remain available and include `activeOperationId` and `activeOperationStartedAt`.

Claims do not expire. A client timeout or old timestamp does not establish that the original executor stopped. If you cannot confirm that the executor and its outstanding backend RPCs have stopped, leave the claim held. Never clear it while execution may continue.

After confirming termination, obtain production-write approval, record the current report, and clear only the exact user, migration, and invocation you reviewed:

```sql
UPDATE lunora_retirement
SET activeOperationId = NULL, activeOperationStartedAt = NULL
WHERE userId = 'REVIEWED_USER_ID'
  AND migrationId = 'REVIEWED_MIGRATION_ID'
  AND activeOperationId = 'REVIEWED_OPERATION_ID';
```

Verify that exactly one row changed and that the claim is now null. This does not release either backend's write fence or change lifecycle state. Retry the same migration only when its policy permits: automatic-policy `uncertain` requires explicit restore review; preserve-policy `uncertain` can resume receipt-bound finalization. Do not assign a new migration id manually or delete retained backups.

## Restore the pre-migration classic snapshot

Use this only when the recorded immutable classic object and hash are present:

```sh
bun run lunora:retire restore --user USER_ID --execute
```

The operation reads, decodes, and hashes the R2 object, restores it under the matching classic fence, verifies semantic equality, then releases safe fences. If Lunora is already retired, the restored classic content keeps the Lunora preference disabled so clients and MCP stay on classic. If verification or fence release fails, the record remains `uncertain` and classic remains frozen.

## Observation period

The 30-day observation period starts only after every user is either `completed` or confirmed `already-classic`, with no failed or manual-review classifications outstanding. Runtime removal, binding removal, shard deletion, and retirement snapshot deletion belong to later releases and require separate approval.
