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
 * Effect-shaped (ADR 0021): `unfurlTitleE` is the program the Worker router
 * yields; timeout + interruption ride Effect's AbortSignal into each hop fetch,
 * and the body reader is released via `Effect.ensuring`. The public contract is
 * still `string | null` — every "couldn't get a title" reason collapses to null
 * (ADR 0016); typed errors would buy the client nothing.
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

import { Duration, Effect } from "effect";

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
const fetchManualE = Effect.fnUntraced(function* (url: string) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUnfurlTarget(current)) return null;
    const res: Response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(current, {
          method: "GET",
          redirect: "manual",
          signal,
          // Anonymous: none of the user's cookies/headers are forwarded.
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent": USER_AGENT,
          },
        }),
      catch: (cause) => cause,
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
});

/** Read at most MAX_BYTES of the body as text, then cancel the stream. The
 *  title + og:title live in `<head>`, far inside 64KB on any real page, so this
 *  bounds memory/time without missing the title. */
function readCappedTextE(res: Response): Effect.Effect<string, unknown> {
  const reader = res.body?.getReader();
  if (!reader) return Effect.succeed("");
  return Effect.tryPromise({
    try: async () => {
      const decoder = new TextDecoder();
      let out = "";
      let total = 0;
      while (total < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        out += decoder.decode(value, { stream: true });
      }
      out += decoder.decode();
      return out;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.ensuring(
      Effect.promise(() => reader.cancel().catch(() => undefined)),
    ),
  );
}

/** Extract a title from HTML via HTMLRewriter: prefer og:title, then
 *  twitter:title, then the `<title>` element (og/twitter are usually the clean
 *  page-intended title; raw `<title>` is often cluttered). Adapted from
 *  tldraw/cloudflare-workers-unfurl (MIT). */
function extractTitleE(html: string): Effect.Effect<string | null, unknown> {
  return Effect.tryPromise({
    try: async () => {
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
    },
    catch: (cause) => cause,
  });
}

/** Outbound fetch + extract only (no cache). Failures stay in the error channel
 *  so the outer program can fold them to null. */
const fetchAndExtractE = Effect.fnUntraced(function* (url: string) {
  const res = yield* fetchManualE(url);
  if (!res || !res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (!/^(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
    if (res.body) {
      yield* Effect.promise(() => res.body!.cancel().catch(() => undefined));
    }
    return null;
  }
  return sanitizeServerTitle(yield* extractTitleE(yield* readCappedTextE(res)));
});

/**
 * Fetch and return a page's title, or null for any "couldn't get one" reason
 * (disallowed target, non-HTML, unreachable, timed out, no title). Successful
 * non-null results are cached cross-user for 24h; the common "same link pasted
 * again" case then skips the outbound fetch entirely.
 *
 * Effect-shaped: the Worker router `yield*`s this. Timeout interrupts in-flight
 * hop fetches via the runtime AbortSignal (kv-client / links-unfurl parity).
 */
export const unfurlTitleE = Effect.fnUntraced(function* (url: string) {
  if (!isAllowedUnfurlTarget(url)) return null;

  const cached = yield* Effect.tryPromise({
    try: () => caches.default.match(cacheKey(url)),
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (cached) {
    const data = yield* Effect.tryPromise({
      try: () => cached.json() as Promise<{ title?: string | null } | null>,
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => null));
    return data?.title ?? null;
  }

  const title = yield* fetchAndExtractE(url).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(TIMEOUT_MS),
      orElse: () => Effect.succeed<string | null>(null),
    }),
    Effect.orElseSucceed(() => null),
  );

  if (title) {
    yield* Effect.tryPromise({
      try: () =>
        caches.default.put(
          cacheKey(url),
          new Response(JSON.stringify({ title }), {
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=86400",
            },
          }),
        ),
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => undefined));
  }
  return title;
});

/** Promise shell over `unfurlTitleE` for non-Effect call sites. Prefer the
 *  Effect form inside the Worker pipeline. */
export function unfurlTitle(url: string): Promise<string | null> {
  return Effect.runPromise(unfurlTitleE(url));
}
