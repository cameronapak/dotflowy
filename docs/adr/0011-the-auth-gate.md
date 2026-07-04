# The auth gate

Identity is **Better Auth** (`worker/auth.ts`): email + password signup, sessions in D1. Signup is
**invite-gated during alpha**: a `hooks.before` on `/sign-up/email` rejects any request whose
`inviteCode` isn't in the comma-separated `INVITE_CODES` secret — server-side (hiding the signup UI
wouldn't stop a direct POST) and fail-closed (unset = signup off; sign-in untouched). The public
`POST /api/waitlist` (worker/index.ts, per-IP rate-limited, D1 `waitlist` table) collects emails
from people who want an invite. Delete the hook + secret to reopen self-serve signup.
Better Auth's `user` table IS the global identity store and `user.id` is the stable, permanent key
the Worker routes each user's outline Durable Object by. The Worker builds auth **per request**
(`createAuth(env)`) because the D1 binding only exists inside `fetch` — it cannot be a module
singleton.

**The shell is public; only the data API is gated.** The Worker serves the static SPA (so the login
screen can load) and `/api/auth/*` (Better Auth's own handler) without a session; `/api/nodes` and
`/api/kv` require a valid session (`auth.api.getSession`) and 401 otherwise. The client gates the
editor behind `useSession()` (root `AuthGate`) and shows the login screen when signed out. This
**replaced** the old three-tier `authorize()` (Cloudflare Access + localhost + HTTP Basic Auth, in
`git log`): Access can't do public self-serve signup, which a multi-tenant product needs.

**Owner-continuity bridge.** The pre-auth outline lives in the constant `'default'` DO (seeded from
legacy D1). Setting the `OWNER_USER_ID` secret to the owner's `user.id` maps that one account back
to `'default'`, carrying their existing data over with **zero copy** — everyone else routes to their
own `user.id` DO. `ensureSeeded` (the legacy D1 import) therefore runs only for the `'default'` DO;
new users start empty. Removable once that data is wherever it belongs.

**node:crypto** — Better Auth needs it, so wrangler sets `compatibility_flags: ["nodejs_compat"]`.

**Known gap (v1):** no email-verification requirement — no transactional email is wired yet, so
`requireEmailVerification` is off. Harden when an email sender (e.g. Resend) lands.

**Don't:** key the DO off the email (permanent-name orphaning — use `user.id`); make `createAuth` a
module singleton (the D1 binding is request-scoped); gate the static shell (the login screen must
load); or relax the `/api/*` session check to trust a client-supplied id.
