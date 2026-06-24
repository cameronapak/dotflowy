# ADR 0025: HTTP Basic Auth fallback gate (ship without Access)

Status: accepted (2026-06-23), implemented + deployed. Extends
[ADR 0023](./0023-d1-sync-via-worker.md), which made **Cloudflare Access** the
identity boundary. This adds a second, simpler gate so the app is usable in
production **before** Access is configured.

## Context

ADR 0023 scopes every row to the `Cf-Access-Authenticated-User-Email` header and
**fails closed** (401) when it's absent on a non-localhost host. Correct, but it
means the app is non-functional until Access is set up — which needs a custom
domain (Access can't reliably gate a raw `*.workers.dev` URL) plus a Zero Trust
dashboard application + policy. That's a real chunk of setup to do before you can
use what's deployed.

The goal here: a single-user gate that works **today** on the bare
`*.workers.dev` deploy, with no dashboard and no custom domain — while still
keeping the outline private (no anonymous read **or write**).

"Just remove auth" was rejected outright: a server-backed store with no gate is a
publicly readable *and writable* outline on a discoverable URL. Not an option,
even temporarily.

## Decision

**Add an HTTP Basic Auth tier to the Worker's `authorize()`**, tried in order:

1. **Cloudflare Access** — `Cf-Access-Authenticated-User-Email` present → owner =
   that email. (Unchanged; the preferred path when Access is eventually set up.)
2. **Local dev** — localhost hostname → `DEV_OWNER`. (Unchanged.)
3. **Basic Auth** — otherwise, require `Authorization: Basic` against the
   `APP_PASSWORD` secret (`wrangler secret put APP_PASSWORD`). **Fail closed** if
   the secret is unset (the whole site stays locked). Owner = `APP_OWNER`
   (default `'owner'`), deliberately independent of the typed username so any
   username works and the data stays unified under one owner.

**The Worker now gates every path, not just `/api/*`** (`run_worker_first: true`
in wrangler.jsonc). This is the load-bearing detail: a `fetch()` that gets a 401
does **not** trigger the browser's Basic Auth prompt — only a document navigation
does. So the Worker must challenge the `/` document load; the browser then caches
the credentials and sends them on every subsequent asset and `/api` fetch
automatically. The non-`/api` branch still serves assets via `env.ASSETS.fetch`
(SPA fallback intact).

## Consequences

- **Works immediately** on `*.workers.dev` after one `wrangler secret put`. No
  custom domain, no dashboard.
- **Real protection** for a single user. Credentials ride over HTTPS on every
  request; for a shared single-user secret, a constant-time compare is overkill.
- **Honest limits**: one shared password (no per-user identity, no IdP, no
  logout-everywhere). Fine for a personal tool; this is *not* a multi-user auth
  system.
- **Access remains the upgrade path** and still takes precedence tier-1: configure
  Access later and its email header wins, no code change. Set `APP_OWNER` to that
  future email so the existing rows carry over seamlessly.
- **Every request now invokes the Worker** (`run_worker_first: true`), incl.
  static assets — negligible for single-user traffic, well within free-tier
  limits.

## Rejected alternatives

- **No auth at all** — public read/write of personal data. No.
- **Client-embedded shared token** — a "secret" shipped in a static JS bundle is
  readable by anyone who opens the page. Theatre, not a gate.
- **Cloudflare Access now** — the right long-term boundary, but it needs the
  custom-domain + dashboard setup this ADR exists to defer. Tier 1 already
  honors it for when it lands.

## Follow-ups

- **Configure Cloudflare Access** (ADR 0023's deploy step) when ready, ideally on
  a custom domain; it supersedes this gate automatically.
- **Validate the Access JWT** (`Cf-Access-Jwt-Assertion`) — still open (ADR 0023).
