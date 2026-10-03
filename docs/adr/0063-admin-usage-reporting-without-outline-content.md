# Admin usage reporting without outline content

Cam approved this design through `/grill-with-docs` on October 2, 2026. Report
registered users, authentication context, saved experimental preferences, stored
data, and observed activity as separate facts. A registration, retained session,
node timestamp, backup timestamp, migration watermark, or existing shard does not
prove recent use. Missing measurements mean unknown, not inactive.

## The first scaffold is read-only

`/admin/analytics` reads the authoritative D1 user population in cursor pages.
Each page reads classic DO metadata with bounded concurrency and timeouts. The
classic reader returns only a node count and the saved experimental preference;
no outline text or other side-collection values leave storage. Experimental
storage inspection is explicit, per user, and returns only a node count and
migration completion dates. It can initialize an empty shard, so object existence
must never become an adoption metric. Unreadable storage remains unknown.

The API uses the existing server-session admin gate, checks authorization before
methods or input, and returns 404 to unauthorized callers. Responses use
`Cache-Control: private, no-store`. The owner remains in the user list but is
excluded from headline counts by default. If `OWNER_USER_ID` is missing, disclose
that exclusion cannot be applied. Preference totals describe the inspected page,
not the whole population. After experimental runtime retirement, browser and MCP
use classic only. Saved experimental preferences describe retained metadata, not
a current backend choice. User-facing copy calls Lunora "experimental sync."

The admin report installs no activity collector or enable switch.
It cannot accidentally turn on collection. Authentication dates describe the
retained session rows only; expiry and deletion make them incomplete history.

## The consent foundation precedes collection

The local follow-up adds D1 migration `0012_usage_consent.sql`, account-scoped
consent and export endpoints, an optional non-modal notice, and Settings actions.
`USAGE_NOTICE_VERSION=2026-10-02` acknowledges publication of the matching privacy
revision and notice; missing or different values prohibit acceptance. It is not
a collection switch. Decline and withdrawal remain available even when publication
is not acknowledged. No outline request writes activity, and the admin report
continues to say "Not measured."

Each choice creates a fresh, server-generated consent generation. Updating the
choice and deleting that account's daily summaries happen in one D1 transaction.
Future producers capture an accepted generation after authentication and before
dispatching an outline mutation, then retain that exact generation on retry.
The final insert checks acceptance, policy version, generation, account existence,
and retention in one SQL statement. A late delivery cannot inherit a reacceptance,
including when both choices have the same millisecond timestamp. A separate consent
read followed by an unconditional insert is unsafe. Both tables cascade on account
deletion. Export excludes the internal generation and other accounts.

The capture, insert, and purge primitives are tested but deliberately unwired.
Before collection, add durable after-commit delivery for both backends, classify
authoritative substantive changes, bound and erase queued payloads, wire the purge,
and expose coverage start and failures. Best-effort callbacks are not at-least-once
delivery. Do not turn this storage contract into a public activity ingestion API.

## Collection requires a separate rollout

Publish the revised privacy policy before collection, then show an in-app notice
and allow each account to accept or decline. Persist that versioned choice outside
the experimental backend. Do not collect before acceptance; allow withdrawal in
Settings. Missing, declined, or failed consent reads fail closed. Access, export,
account deletion, and withdrawal must cover the new records too.

Use a D1 daily summary keyed by `(userId, UTC day, backend, source, activity)`:
backend = classic or experimental, source = browser or MCP, activity = opened or
edited. Idempotent presence rows suffice; no event log, edit counts, timestamps per
event, node IDs, outline text, URLs, IPs, device details, or time-spent tracking.
Keep at most 90 UTC calendar days with a scheduled purge and cascade on user
deletion. Record and display when each signal's coverage began; no historical
backfill from sessions, backups, or node timestamps.

- **Opened outline:** loaded in a visible, focused browser tab, at most one row
  per user/backend/day. Opening is not proof of reading. No heartbeat.
- **Browser edit:** an intentional action commits a content or structural change,
  including undo and intentional imports. Exclude no-ops, collapse-only changes,
  automatic scaffolding, seed, migration, and operator restore.
- **MCP edit:** committed agent edits, reported separately. Agent-only activity
  does not enter the headline human-use total.
- **People who opened or edited:** unique users in the union, never the sum.
  Report 7-/30-day windows, experimental use, and any-activity totals separately.

Determine edits from authoritative changes, not successful requests or the
optimistic browser. Classic write commits and Lunora browser/MCP mutations both
need coverage. The pinned Lunora API supports after-commit scheduling via
`ctx.scheduler.runAfter(0, internalAction, args)`; inline D1 I/O is not part of its
transaction. Delivery is at least once, so summary writes must be idempotent.
Reporting failures must not undo outline writes, and must make coverage gaps
visible. Do not add a scheduler or an instrumentation seam solely for this first
read-only scaffold.

These boundaries preserve privacy and avoid manufacturing evidence of adoption.
They deliberately trade immediate active-use totals for honest coverage and an
advance-notice rollout. PR #361's retirement and rollback behavior is separate.
