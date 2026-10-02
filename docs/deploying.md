# Deploying to Cloudflare

The repo deploys to **Cloudflare Workers**: one Worker (`worker/index.ts`)
serves the static SPA _and_ routes the `/api/nodes` + `/api/kv` sync APIs to a
**per-user Durable Object**, behind **Better Auth** accounts
([the auth gate](./adr/0011-the-auth-gate.md)). Config is in `wrangler.jsonc`.
Full design: [the sync design](./adr/0008-sync-via-a-per-user-durable-object.md).

```sh
bun install
bun run setup        # generates BETTER_AUTH_SECRET + applies the local D1 schema
bun run dev          # starts the app (vite :3000 + worker :8787) in one command
bun run seed:user    # (optional) creates dev@dotflowy.local / dotflowy-dev to sign in with

# or a production-like single-server preview
bun run cf:dev             # build + wrangler dev

# ship it
wrangler secret put BETTER_AUTH_SECRET   # once: the auth signing secret
wrangler secret put INVITE_CODES         # optional: invite codes (a signup backdoor; see Auth below)
bun run db:migrate:remote  # before the first deploy
bun run deploy             # build + wrangler deploy
```

The local invite code is **`dev-invite`** if you'd rather sign up your own
account; `bun run seed:user` skips that by creating a ready-to-use account.

`build:cf` copies the TanStack Start shell (`_shell.html`) to `index.html` so
the root and client routes (e.g. `/<nodeId>` zoom views) resolve through the
SPA fallback.

## Automatic production deployment

The **App Release and Deploy** workflow runs on every push to `main`. Merging
approves the app release and production deployment. It selects current `main`,
runs the same quality checks as CI, then:

1. Runs `bun scripts/release.ts --ci`. Nonempty app changesets produce a version,
   archived changelog, release commit, and annotated tag. No news means no bump.
2. Typechecks the landing site and builds both sites before publishing anything.
3. Pushes the release commit and tag atomically, then publishes the GitHub Release.
4. Deploys the landing Worker (`dotflowy.com`), then the app Worker
   (`app.dotflowy.com`), using those builds.
5. Checks the version in both public `changelog.json` assets, both homepages,
   and the app's public auth configuration endpoint.

Only one production workflow runs at a time. It finishes the active deployment;
intermediate waiting runs can be replaced by the newest run. The next run selects
current `main` and releases all pending app changesets together. The CLI's npm
release workflow remains independent.

### GitHub configuration

Add these under **Settings → Secrets and variables → Actions → New repository
secret**:

| Name                    | Value                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare deployment token, using the Edit Cloudflare Workers template, scoped to the account and `dotflowy.com` zone. |
| `CLOUDFLARE_ACCOUNT_ID` | The account that owns both Workers.                                                                                     |
| `SENTRY_AUTH_TOKEN`     | Optional Sentry organization token for client source-map uploads.                                                       |

The workflow uses GitHub's built-in `GITHUB_TOKEN` with Contents write permission
for release commits, tags, and GitHub Releases. Its pushes do not trigger another
workflow run. `main` must permit that release commit; branch protection that
requires a PR needs a different release approval flow. Never bypass it with a
force push. Runtime secrets such as `BETTER_AUTH_SECRET` stay in Cloudflare.

The token template grants account-level Worker access, not access limited to
these two Workers. Keep account and zone resource scopes as narrow as possible.

### Failures and retries

A failed step stops the run. If landing deploys but the app fails, the sites can
temporarily differ. The GitHub Release can also precede the live app. Neither
failure triggers an automatic rollback.

To retry, open **Actions → App Release and Deploy → Run workflow**, select `main`,
and run it. This validates current `main`, not an old failed commit. If no newer
news has merged, it reuses the pushed version/tag and skips an existing published
GitHub Release. It rebuilds and redeploys both sites. Prefer a fresh run over
rerunning only the failed job, which retains the earlier selected commit.

A merge during release preparation rejects the atomic push, before the GitHub
Release or either deployment. The queued run handles the newer `main`. Never
force or rebase the already-built candidate.

The workflow does **not** run D1 SQL migrations or data backfills. Approve and run
those separately before deploying code that requires them. Wrangler still applies
Durable Object class migrations declared in `wrangler.jsonc`; review changes to
that migration list before merging.

## Auth

Identity is **Better Auth** (email + password, with email verification),
sessions in D1. Signup is **open** — `SIGNUP_OPEN="true"`, human-gated by
**Cloudflare Turnstile** (`TURNSTILE_SECRET_KEY` + the public
`TURNSTILE_SITE_KEY`). Leave `SIGNUP_OPEN` unset to fall back to invite-only,
where an account needs a code from the `INVITE_CODES` secret or a per-email
invite; both stay valid as backdoors in every state, and the public
`POST /api/waitlist` still collects emails (viewable by admins — the
`ADMIN_EMAILS` var — at `/admin/waitlist`).

The static shell is public so the login screen loads; only `/api/nodes` +
`/api/kv` require a session. Set `BETTER_AUTH_SECRET`
(`wrangler secret put`) in prod and `.dev.vars` locally — without it the
Worker fails closed. To carry a pre-auth outline (the constant `'default'` DO)
into your real account, set the `OWNER_USER_ID` secret to your `user.id` after
signing up. See [the auth gate](./adr/0011-the-auth-gate.md).
