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
