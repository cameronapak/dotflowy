/// <reference types="@cloudflare/workers-types" />

/**
 * Link title unfurl (ADR 0016). Given a user-supplied URL, fetch the page
 * server-side and return its title, so a pasted bare URL can have its label
 * upgraded from the raw url to the real page title. The browser can't do this
 * (CORS), hence a Worker endpoint -- but fetching an arbitrary user URL is an
 * authenticated SSRF surface, so the fetch here is the security boundary and is
 * hardened accordingly (scheme + hostname guard, manual redirects with per-hop
 * revalidation, no credential forwarding, a timeout, a byte cap, a content-type
 * gate). The route in worker/index.ts gates it behind the session + a rate limit.
 *
 * The pure decisions (target guard, title sanitizer, the http(s) param check)
 * live in unfurl-core.ts so they import cleanly under `bun test`; this module is
 * the impure half (fetch + HTMLRewriter) and needs the CF runtime.
 *
 * The HTMLRewriter title extraction is adapted from tldraw/cloudflare-workers-unfurl
 * (MIT License, https://github.com/tldraw/cloudflare-workers-unfurl) -- its own
 * fetch is unguarded (follows redirects, no timeout, reads the whole body), so we
 * borrow only the extractor and own the hardened fetch. We need only the title,
 * so its description/image/favicon handlers are intentionally dropped.
 */

import { isAllowedUnfurlTarget, sanitizeServerTitle } from "./unfurl-core";

export { isHttpUrlString } from "./unfurl-core";

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = "dotflowy-bot/1.0 (+https://app.dotflowy.com)";

/** Cross-user cache key (titles are public, not user-specific). A synthetic
 *  same-shape Request keyed on the normalized url. */
function cacheKey(url: string): Request {
  return new Request(
    `https://unfurl-cache.dotflowy.invalid/?u=${encodeURIComponent(url)}`,
  );
}

/** GET the page with redirects handled manually so each hop is re-validated
 *  against the SSRF guard. Returns the final non-redirect Response, or null if a
 *  hop is disallowed / there are too many hops / a hop has no Location. */
async function fetchManual(
  url: string,
  signal: AbortSignal,
): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUnfurlTarget(current)) return null;
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal,
      // Anonymous: none of the user's cookies/headers are forwarded.
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": USER_AGENT,
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      current = new URL(loc, current).href;
      continue;
    }
    return res;
  }
  return null;
}

/** Read at most MAX_BYTES of the body as text, then cancel the stream. The
 *  title + og:title live in `<head>`, far inside 64KB on any real page, so this
 *  bounds memory/time without missing the title. */
async function readCappedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

/** Extract a title from HTML via HTMLRewriter: prefer og:title, then
 *  twitter:title, then the `<title>` element (og/twitter are usually the clean
 *  page-intended title; raw `<title>` is often cluttered). Adapted from
 *  tldraw/cloudflare-workers-unfurl (MIT). */
async function extractTitle(html: string): Promise<string | null> {
  let titleText = "";
  let ogTitle: string | null = null;
  let twitterTitle: string | null = null;

  await new HTMLRewriter()
    .on("title", {
      text(t) {
        titleText += t.text;
      },
    })
    .on("meta", {
      element(el) {
        const property = el.getAttribute("property");
        const name = el.getAttribute("name");
        if (property === "og:title") ogTitle = el.getAttribute("content");
        else if (name === "twitter:title")
          twitterTitle = el.getAttribute("content");
      },
    })
    .transform(new Response(html))
    .arrayBuffer();

  return ogTitle ?? twitterTitle ?? (titleText || null);
}

/**
 * Fetch and return a page's title, or null for any "couldn't get one" reason
 * (disallowed target, non-HTML, unreachable, timed out, no title). Successful
 * non-null results are cached cross-user for 24h; the common "same link pasted
 * again" case then skips the outbound fetch entirely.
 */
export async function unfurlTitle(url: string): Promise<string | null> {
  if (!isAllowedUnfurlTarget(url)) return null;

  const cached = await caches.default.match(cacheKey(url));
  if (cached) {
    const data = (await cached.json().catch(() => null)) as {
      title?: string | null;
    } | null;
    return data?.title ?? null;
  }

  try {
    const res = await fetchManual(url, AbortSignal.timeout(TIMEOUT_MS));
    if (!res || !res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!/^(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const title = sanitizeServerTitle(
      await extractTitle(await readCappedText(res)),
    );
    if (title) {
      await caches.default.put(
        cacheKey(url),
        new Response(JSON.stringify({ title }), {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=86400",
          },
        }),
      );
    }
    return title;
  } catch {
    // Timeout, network error, malformed redirect Location -- all "no title".
    return null;
  }
}
