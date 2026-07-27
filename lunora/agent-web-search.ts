/**
 * Firecrawl-backed `web_search` for the inline agent (ADR 0059).
 * Fail closed when the key is missing — callers omit the tool entirely.
 */

import { Data, Duration, Effect, Schema } from "effect";

import {
  clampWebSearchLimit,
  formatWebSearchResults,
  type WebSearchHit,
} from "../src/data/agent-web-search";

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const SEARCH_TIMEOUT = Duration.seconds(15);

export class FirecrawlSearchError extends Data.TaggedError(
  "FirecrawlSearchError",
)<{
  readonly reason: string;
}> {}

export const WebSearchInputSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  /** Clamped to 1..WEB_SEARCH_MAX_RESULTS in the execute path. */
  limit: Schema.optional(Schema.Number),
});

export type WebSearchInput = Schema.Schema.Type<typeof WebSearchInputSchema>;

type FirecrawlWebHit = {
  title?: unknown;
  url?: unknown;
  description?: unknown;
};

function parseHits(body: unknown): WebSearchHit[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: { web?: unknown } }).data;
  const web = data?.web;
  if (!Array.isArray(web)) return [];

  const hits: WebSearchHit[] = [];
  for (const row of web) {
    if (!row || typeof row !== "object") continue;
    const r = row as FirecrawlWebHit;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!title || !url) continue;
    const description =
      typeof r.description === "string" ? r.description.trim() : "";
    hits.push(description ? { title, url, description } : { title, url });
  }
  return hits;
}

/**
 * POST Firecrawl `/v2/search` and return a compact JSON string for the model.
 */
export const firecrawlWebSearchE = Effect.fnUntraced(function* (opts: {
  apiKey: string;
  query: string;
  limit?: number;
}) {
  const limit = clampWebSearchLimit(opts.limit);
  const res = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(FIRECRAWL_SEARCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: opts.query,
          limit,
          sources: ["web"],
        }),
        signal,
      }),
    catch: (err) =>
      new FirecrawlSearchError({
        reason: err instanceof Error ? err.message : String(err),
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: SEARCH_TIMEOUT,
      orElse: () =>
        Effect.fail(new FirecrawlSearchError({ reason: "search timed out" })),
    }),
  );

  if (!res.ok) {
    return yield* Effect.fail(
      new FirecrawlSearchError({
        reason: `search unavailable (${res.status})`,
      }),
    );
  }

  const json: unknown = yield* Effect.tryPromise({
    try: () => res.json(),
    catch: (err) =>
      new FirecrawlSearchError({
        reason: err instanceof Error ? err.message : String(err),
      }),
  });

  if (
    !json ||
    typeof json !== "object" ||
    (json as { success?: unknown }).success === false
  ) {
    const errMsg =
      json &&
      typeof json === "object" &&
      typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : "search unavailable";
    return yield* Effect.fail(new FirecrawlSearchError({ reason: errMsg }));
  }

  return formatWebSearchResults(parseHits(json));
});
