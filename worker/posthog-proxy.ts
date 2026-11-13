/// <reference types="@cloudflare/workers-types" />

/**
 * PostHog reverse proxy for faith.tools (replaces the retired Val Town val
 * `cameronapak/reverse-proxy-posthog-faith-tools`, which stopped running
 * 2027-01-10). faith.tools points its PostHog `api_host` at
 * `https://e.dotflowy.com`; this Worker serves that subdomain and forwards
 * requests to PostHog's US hosts.
 *
 * Routing follows PostHog's self-hosted proxy reference: `/static/*` and
 * `/array/*` go to the asset host, everything else to the ingestion host.
 * The proxy holds no secrets and no storage. It strips browser cookies,
 * forwards only PostHog project-key `Authorization` values, and preserves
 * the client IP via `X-Forwarded-For` for geolocation and cookieless
 * counting (faith.tools runs `cookieless_mode: 'always'`, which hashes
 * IP + user agent server-side).
 *
 * See docs/adr/0084-faith-tools-posthog-proxy.md for why this lives here.
 */

export const POSTHOG_PROXY_HOSTNAME = "e.dotflowy.com";

const API_HOST = "us.i.posthog.com";
const ASSET_HOST = "us-assets.i.posthog.com";

const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS"]);

/** True when the request arrived on the proxy subdomain. */
export function isPostHogProxyRequest(url: URL): boolean {
  return url.hostname === POSTHOG_PROXY_HOSTNAME;
}

/** Asset paths go to the asset host; everything else to the ingestion host. */
function upstreamHost(pathname: string): string {
  return pathname.startsWith("/static/") || pathname.startsWith("/array/")
    ? ASSET_HOST
    : API_HOST;
}

/**
 * Capture v1 SDKs send the project token as `Authorization: Bearer phc_...`;
 * server SDKs use `phs_`/`phx_` for local flag evaluation. Keep only those;
 * strip anything else (e.g. a session token our own requests might add).
 */
function isPostHogAuthorization(value: string): boolean {
  return (
    value.startsWith("Bearer phc_") ||
    value.startsWith("Bearer phs_") ||
    value.startsWith("Bearer phx_")
  );
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin");
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "*",
    vary: "Origin",
  };
}

/**
 * Forward one browser request to PostHog and return its response. `fetcher`
 * is injectable for tests; production uses the global `fetch`.
 */
export async function proxyPostHog(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const cors = corsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (!ALLOWED_METHODS.has(request.method)) {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const incoming = new URL(request.url);
  const host = upstreamHost(incoming.pathname);
  const upstreamUrl = `https://${host}${incoming.pathname}${incoming.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");
  const authorization = headers.get("authorization");
  if (authorization && !isPostHogAuthorization(authorization)) {
    headers.delete("authorization");
  }
  const clientIp =
    headers.get("cf-connecting-ip") ??
    headers.get("x-forwarded-for") ??
    undefined;
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetcher(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    return new Response(JSON.stringify({ error: "bad gateway" }), {
      status: 502,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const response = new Response(upstream.body, upstream);
  for (const [key, value] of Object.entries(cors)) {
    if (!response.headers.has(key)) response.headers.set(key, value);
  }
  return response;
}
