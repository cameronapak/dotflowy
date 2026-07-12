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

**Google sign-in (sign-IN only, explicit linking).** `socialProviders.google` is registered when the
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` secrets exist, with **`disableSignUp: true`** — the OAuth
face of the invite gate. It must be `disableSignUp` (hard), not `disableImplicitSignUp`, which a
client-supplied `requestSignUp: true` waives — that would be an invite bypass. A Google identity
with no account gets `?error=signup_disabled` back on the AuthScreen. **Linking an existing
email+password account to Google is EXPLICIT only** (`linkSocial` behind the More menu's "Connect
Google", while signed in): implicit linking on a signed-out Google sign-in stays at Better Auth's
default, which refuses when the local email is unverified — all of ours, since no verification
email is wired — because an attacker who pre-registered the victim's address could otherwise
capture the victim's Google identity into an attacker-owned account. Don't reach for
`requireLocalEmailVerified: false`: deprecated upstream, and the gate becomes unconditional next
minor. `allowDifferentEmails: true` loosens only the authenticated explicit-link path (the session
proves ownership); the signed-out lookup is email-keyed, so a different-address Google sign-in
finds no account and hits the signup gate. Linking preserves `user.id`, so the outline DO routing
never changes. The whole flow is navigation-based (redirects, fresh page loads), which satisfies
the hardReset teardown rule by construction; on an MCP OAuth hop the AuthScreen passes
`/api/auth/mcp/authorize?<query>` as the `callbackURL`, so the Google callback itself resumes the
authorize flow top-level.

**node:crypto** — Better Auth needs it, so wrangler sets `compatibility_flags: ["nodejs_compat"]`.

**Known gap (v1):** no email-verification requirement — no transactional email is wired yet, so
`requireEmailVerification` is off. Harden when an email sender (e.g. Resend) lands.

**Don't:** key the DO off the email (permanent-name orphaning — use `user.id`); make `createAuth` a
module singleton (the D1 binding is request-scoped); gate the static shell (the login screen must
load); or relax the `/api/*` session check to trust a client-supplied id.
