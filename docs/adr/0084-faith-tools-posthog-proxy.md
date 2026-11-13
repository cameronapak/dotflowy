---
status: accepted
---

# faith.tools PostHog proxy lives on e.dotflowy.com

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
