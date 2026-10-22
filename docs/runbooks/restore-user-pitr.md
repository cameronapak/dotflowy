# Runbook: restore one user's outline (Durable Object PITR)

Restore a single user's outline to a point within the last **30 days**, using the
free Point-in-Time Recovery every SQLite-backed Durable Object gets automatically.
Because one DO holds exactly one user, the restore is isolated **by construction** —
no other user is touched. Ticket [#220](https://github.com/cameronapak/dotflowy/issues/220),
research in [#155](https://github.com/cameronapak/dotflowy/issues/155).

> **Deployed only.** PITR needs Cloudflare's storage change log, which does **not**
> exist in local `wrangler dev`. The route and page load locally, but a restore
> call will not actually roll anything back off a dev machine. Verify against a
> deployed environment (prod/staging).

## Who can run it

The endpoint is gated by the `ADMIN_EMAILS` allowlist (a `wrangler.jsonc` var),
exactly like `/admin/waitlist`. It is **fail-closed**: unset = nobody, and a
non-admin (or unauthenticated) caller gets the same `404` a missing route would —
the surface never advertises itself. You must be signed in to the app with an
admin email, and send that session's cookie with the request.

## 1. Find the user id

The Durable Object is keyed by the stable Better Auth `user.id`, which lives in D1.
You can pass an **email** to the tools below and they look the id up for you, or
resolve it yourself:

```sh
# Prod (omit --remote for the local D1 copy)
bunx wrangler d1 execute dotflowy-db --remote \
  --command "SELECT id, email FROM \"user\" WHERE lower(email) = lower('user@example.com')"
```

(The binding/database name is whatever `wrangler.jsonc` calls the D1 database.)

> **Owner note.** If the target is the app owner (the `OWNER_USER_ID` account), the
> route resolves them to the constant `'default'` DO automatically — you still pass
> their normal email/id, no special casing.

## 2a. Restore via the admin page (no curl)

Sign in as an admin, then open the **unlinked** page:

```
https://<app-origin>/admin/restore
```

- Enter the user's **email or id**.
- Pick a **restore time** in your local timezone (or paste a **bookmark** for the
  undo path — see §4).
- Click **Review restore…**, read the destructive confirmation, then **Confirm
  restore**.
- On success the page shows the **previous bookmark** and **target bookmark** with
  copy buttons. **Save the previous bookmark** — it is your undo handle.

A non-admin who opens the page and submits just sees "Not found." — same as the
waitlist page.

## 2b. Restore via curl

Send your signed-in admin session cookie. Identify the user by `email` **or**
`userId`, and give a restore point as `at` (ISO string or epoch ms) **or**
`bookmark`.

```sh
curl -sS -X POST "https://<app-origin>/api/admin/restore" \
  -H "content-type: application/json" \
  -H "cookie: <your admin session cookie>" \
  -d '{"email":"user@example.com","at":"2026-07-16T09:30:00Z"}'
```

Success returns the two bookmarks:

```json
{
  "previousBookmark": "0000007b-0000-...-pre",
  "targetBookmark": "00000042-0000-...-target"
}
```

The restore is **armed immediately** and the DO restarts within a second or two;
open tabs reconnect and pull a fresh snapshot of the restored state (they can't be
left on a broken resume — the DO answers their now-too-high cursor with a full
snapshot). **Copy `previousBookmark` somewhere safe before moving on.**

## 3. What "success" means (and the timing detail)

The RPC captures the pre-recovery bookmark, arms the restore
(`onNextSessionRestoreBookmark`, which **persists** across the restart), returns
the two bookmarks, and only **then** calls `ctx.abort()` to restart the object.
Aborting is deferred on purpose: `ctx.abort()` tears the DO down instantly, so
calling it before the reply left would kill the response and you'd never see the
undo bookmark. Because the restore is already armed and durable, even if that
deferred abort is lost (e.g. the object is evicted first) the restore still applies
on the object's next natural start — the delay only makes the rollback prompt.

## 4. Undo a bad restore

Every successful restore hands back a `previousBookmark` — the exact "now" from
just before it ran. To reverse a restore, restore **to that bookmark**:

```sh
curl -sS -X POST "https://<app-origin>/api/admin/restore" \
  -H "content-type: application/json" \
  -H "cookie: <your admin session cookie>" \
  -d '{"email":"user@example.com","bookmark":"0000007b-0000-...-pre"}'
```

or paste it into the page's bookmark field. That call returns a _new_
`previousBookmark` (the state you're undoing from), so the undo is itself
reversible. Bookmarks only resolve within the same 30-day window.

## 5. Errors you might see

| Response                                                    | Meaning                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `404 {"error":"not found"}`                                 | Not an admin (or not signed in). Same as a missing route — by design. |
| `400 a restore time or a bookmark is required`              | Gave neither `at` nor `bookmark`.                                     |
| `400 provide either a restore time or a bookmark, not both` | Gave both.                                                            |
| `400 restore time is older than the 30-day recovery window` | `at` is outside PITR retention.                                       |
| `400 restore time is in the future`                         | `at` is ahead of now.                                                 |
| `400 no user with email …`                                  | No account matches that email.                                        |
| `500`                                                       | An unexpected DO/storage fault — check Workers Logs / Sentry.         |

## Scope / limits

- 30-day retention only; no self-serve or automated restore (operator-invoked).
- Whole-DB rollback per user (all of `nodes`/`kv`/`meta`/`changelog`), not
  per-table or per-node.
- Not covered here: off-site R2 backups (the ">30 days" / account-catastrophe
  tier) — a separate, non-beta-blocking effort (#155 §2).
