---
status: accepted
---

# Separate faith.tools analytics from Dotflowy

## Approved replacement

Cam approved this separation on November 13, 2026. Use the dedicated
`faith-tools-analytics` Worker at `e.faith.tools`, with code in faith.tools's
`analytics/` directory and an independent Wrangler config and deployment
workflow. It must not share Dotflowy's app Worker, storage bindings, secrets,
or release lifecycle. Verify hostname availability before provisioning it.

The Dotflowy removal must follow the cutover. Do not merge or deploy it until
the API-key, Android-share, and mobile-changelog releases finish, the replacement
passes real ingestion checks, and `e.dotflowy.com` is served outside the Dotflowy app Worker.
Keep that old hostname working on the replacement for cached and already-open
faith.tools pages; do not redirect event POSTs. Transfer it only after checking
Cloudflare's custom-domain handoff and rollback behavior. Subsequent Dotflowy
deploys and rollbacks must not reclaim it from the analytics Worker.

Move faith.tools's browser `api_host` to the new hostname,
preserving its PostHog project, US upstreams, `ui_host`, and cookieless settings.
Server capture and query clients remain direct to PostHog. Retire the old
hostname only after traffic evidence and separate approval, not after an
arbitrary DNS TTL.

Remove the proxy's v3.3.1 fragment and its `CHANGELOG.md` bullet. Rebuild both
sites to clear their JSON feeds and compiled changelog views. Edit the existing
GitHub v3.3.1 release body as part of the cutover; keep the version, date,
zoom-out entry, and tag. This is not new user-facing news and gets only an
empty changeset. Old tagged source and already-loaded bundles remain historical
copies; do not rewrite tags or reset users' changelog cursors.

## Original decision, accepted November 13, 2026

faith.tools sent its browser analytics through a Val Town reverse proxy
(`cameronapak/reverse-proxy-posthog-faith-tools`). Val Town is shutting down:
code becomes read-only Dec 10, 2026, and vals stop running Jan 10, 2027. Cam
chose to host the replacement here over PostHog's managed reverse proxy.

This Worker serves `e.dotflowy.com` alongside the app and forwards to
PostHog's US hosts (`worker/posthog-proxy.ts`): `/static/*` and `/array/*`
to `us-assets.i.posthog.com`, everything else to `us.i.posthog.com`.
faith.tools points its `api_host` at `https://e.dotflowy.com` directly, with
`ui_host` set to `https://us.posthog.com`.

The proxy holds no secrets and no storage. It strips browser cookies,
forwards only `Bearer phc_/phs_/phx_` authorization values, and preserves the
client IP via `X-Forwarded-For` for geolocation and cookieless counting.

Managed proxy was simpler (no code to maintain, PostHog handles SSL), but it
adds a CNAME to `*.proxy-us.posthog.com` that DNS uncloaking resolvers can
detect, routes data through Cloudflare under PostHog's terms, and needs the
PostHog dashboard plus a faith.tools DNS change. Hosting here keeps the code,
the domain, and the deploy in Cam's own infrastructure, at the cost of
maintaining the small forwarder. If faith.tools analytics ever needs to
survive a Dotflowy Worker outage, or the proxy needs HIPAA-covered handling,
revisit this decision.
