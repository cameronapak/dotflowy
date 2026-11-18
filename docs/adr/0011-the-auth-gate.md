# The auth gate

Identity is **Better Auth** (`worker/auth.ts`): email + password and Google signup, sessions in D1. Signup has
**three states**, decided server-side (hiding UI wouldn't stop a direct POST):

- **CLOSED** — `INVITE_CODES` unset/empty and no per-email invite matches: nobody can create an
  account. Fail-closed default.
- **INVITE** (alpha default) — a `hooks.before` accepts the request only if its `inviteCode` is a
  valid per-email single-use invite (#251) or is in the comma-separated `INVITE_CODES` secret. The
  public `POST /api/waitlist` (per-IP rate-limited, D1 `waitlist` table) collects emails from people
  who want one.
- **OPEN** (#293) — `SIGNUP_OPEN === "true"` (fail-closed: only that exact literal opens it; the
  pure gate is `isSignupOpen` in `worker/identity.ts`) skips the invite requirement. Signup is then
  gated by **Cloudflare Turnstile** on the email path when configured. Google signup uses Google's
  OAuth flow, not the email captcha endpoint. `wrangler.jsonc` currently sets `SIGNUP_OPEN` to `"true"`;
  the local `.dev.vars.example` keeps it unset. `INVITE_CODES` and per-email
  invites stay working as permanent backdoors regardless of state.

**Turnstile** (#293) is Better Auth's `captcha` plugin, provider `cloudflare-turnstile`, registered
**only when `TURNSTILE_SECRET_KEY` is set** (the optional-secrets pattern — no key = no plugin =
signup/reset behave exactly as before; local dev and forks unaffected). It gates **exactly**
`/sign-up/email` and `/request-password-reset` (the client's real reset endpoint; `/forget-password`
is its legacy alias) — deliberately **NOT sign-in**, which must stay token-free so the MCP OAuth
resume path keeps working and Better Auth's own rate limiting carries the brute-force load. The
client sends the solved token in the `x-captcha-response` header (the plugin's `onRequest` reads
exactly that, fails closed on missing/invalid). The SPA learns the mode + PUBLIC site key from the
dumb, session-free **`GET /api/auth-config`** (`{signupOpen, turnstileSiteKey}`) and renders the
widget (`src/components/turnstile.tsx`, a hand-rolled wrapper over Cloudflare's script — no
dependency) only when a key is present, so no-key = no-widget matches plugin-unregistered parity.

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

**Google sign-in and open signup.** `socialProviders.google` is registered when the
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` secrets exist, with **`disableSignUp: !isSignupOpen(env)`**.
When signup is open, a first Google sign-in creates an account and session; Google's verified-email
claim supplies the account's verification state. There is no password or separate Dotflowy email
confirmation for a Google-verified address. The Google button appears on both sign-in and open-signup
screens. When signup is not open, Google can only sign in or link existing accounts: new users get
`?error=signup_disabled`, with instructions to redeem an invite through email signup and verify first.
Invite codes are not transported through OAuth. It must be `disableSignUp` (hard), not
`disableImplicitSignUp`, which a client-supplied `requestSignUp: true` waives. Turning signup off
does not lock out existing Google accounts. **Linking an existing
email+password account to Google:** the EXPLICIT path (`linkSocial` behind the More menu's "Connect
Google", while signed in) always works. IMPLICIT linking on a signed-out Google sign-in stays at
Better Auth's default, which refuses when the local email is **unverified** — because an attacker who
pre-registered the victim's address could otherwise capture the victim's Google identity into an
attacker-owned account. **Now that verification is ON (#293), a VERIFIED account's signed-out Google
sign-in links implicitly** — the gate lifts for exactly the accounts we can trust, with **zero code
change** (verified from the Better Auth source, `oauth2/link-account.mjs`: the refusal is
`(!trustedProvider && !googleEmailVerified) || (requireLocalEmailVerified && !localEmailVerified) ||
…`; `requireLocalEmailVerified` defaults `true`, `trustedProviders: ["google"]` clears the first
clause, and a `true` local `emailVerified` clears the second, so both fail and linking proceeds).
Existing accounts are grandfathered verified (migration 0008), so this works for them from day one; a
still-unverified brand-new signup stays refused until it confirms. Don't reach for
`requireLocalEmailVerified: false`: deprecated upstream, and the gate becomes unconditional next
minor. `allowDifferentEmails: true` loosens only the authenticated explicit-link path (the session
proves ownership); the signed-out lookup is email-keyed, so a different-address Google sign-in
finds no account and either creates a separate account while signup is open or hits the signup gate.
Linking preserves `user.id`, so the outline DO routing
never changes. The whole flow is navigation-based (redirects, fresh page loads), which satisfies
the hardReset teardown rule by construction; on an MCP OAuth hop the AuthScreen passes
`/api/auth/mcp/authorize?<query>` as the `callbackURL`, so the Google callback itself resumes the
authorize flow top-level.

Google-only users can set a password through the existing emailed Forgot password flow. Account
deletion still requires password confirmation, and API keys still bind to a password version;
their UI/error guidance points Google-only users to this flow rather than weakening those guards.
`worker/auth-real.test.ts` exercises the real Better Auth handler, D1 and session cookies with only
Google's token-exchange transport replaced: open signup, closed/malformed-mode refusal despite
`requestSignUp`, email invites, repeat Google sign-in after closure, and verified-only linking.

**node:crypto** — Better Auth needs it, so wrangler sets `compatibility_flags: ["nodejs_compat"]`.

**Transactional email** is wired (map #151 / #169): Cloudflare Email Service via the Workers
`send_email` binding, every sender funneled through the one `worker/email.ts` seam (the
provider-swap point; Resend is the named fallback). Password reset works: `sendResetPassword`
rides `ctx.waitUntil` (uniform response timing — no enumeration side channel — and the isolate
outlives the response) with `revokeSessionsOnPasswordReset: true`; the public `/reset-password`
route renders OUTSIDE the root AuthGate. **`requireEmailVerification` is now ON (#293)**: with signup
able to open to the public, an unverified address is a real hole (anyone could sign up as anyone), so
an account can't create a session until it confirms its email. `emailVerification.sendVerificationEmail`
rides the same `ctx.waitUntil` + `worker/email.ts` seam as the reset mail (same isolate-lifetime and
timing reasoning). **Existing alpha accounts are grandfathered verified** by a one-time
`UPDATE "user" SET emailVerified = 1` (migration 0008) so none is locked out on deploy; new signups
verify through the emailed link. `bun run seed:user` flips the local dev account verified directly in
D1 (no inbox to click) so it stays immediately sign-in-able. Two client-facing consequences the
AuthScreen handles: (1) **a successful signup returns `token: null` and NO session**, so the screen
does NOT hard-navigate on that shape — it flips to sign-in mode with a "check your inbox, then sign
in" notice (guarded on `token === null` specifically, so turning verification off restores the old
navigate-on-success flow untouched; staying put also keeps an MCP OAuth `?client_id…` query in the
URL, so a signup mid-OAuth-hop resumes through the normal sign-in path after confirming); (2) an
unverified sign-in with the **correct password** gets `EMAIL_NOT_VERIFIED`, which the screen renders
as a friendly "we just sent you a fresh link" notice — true because `emailVerification.sendOnSignIn:
true` is set (verified from the Better Auth 1.6.23 source, `api/routes/sign-in.mjs`: WITHOUT that
flag it just throws with no resend; WITH it, the resend fires only after the password check passes,
so it can't be used to spam arbitrary addresses — which is why no separate "resend" button exists).
Turning verification on is also what makes implicit Google linking start working for verified
accounts (see above).

**Don't:** key the DO off the email (permanent-name orphaning — use `user.id`); make `createAuth` a
module singleton (the D1 binding is request-scoped); gate the static shell (the login screen must
load); or relax the `/api/*` session check to trust a client-supplied id.
