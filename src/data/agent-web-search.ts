/**
 * Pure helpers for the inline agent's `web_search` tool (ADR 0059).
 * Network I/O lives in `lunora/agent-web-search.ts`.
 */

export const WEB_SEARCH_MAX_RESULTS = 5;
export const WEB_SEARCH_MAX_PER_RUN = 3;

export type WebSearchHit = {
  title: string;
  url: string;
  description?: string;
};

/** Compact JSON the model can cite as `[title](url)` markdown links. */
export function formatWebSearchResults(hits: readonly WebSearchHit[]): string {
  if (hits.length === 0) {
    return JSON.stringify({ results: [], note: "No results" });
  }
  return JSON.stringify({
    results: hits.map((h) => ({
      title: h.title,
      url: h.url,
      ...(h.description ? { description: h.description } : {}),
    })),
    citeAs: "Inline markdown links [title](url) in the answer body.",
  });
}

export function clampWebSearchLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return WEB_SEARCH_MAX_RESULTS;
  }
  return Math.min(WEB_SEARCH_MAX_RESULTS, Math.max(1, Math.floor(limit)));
}
