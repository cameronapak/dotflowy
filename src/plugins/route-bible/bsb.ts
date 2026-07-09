// Client-side BSB chapter loader for the passage-edit popover mini-reader.
// Same-origin GET `/api/bible/bsb` (session cookie rides). Failures collapse
// to null so the popover keeps working as a pure reference editor.

export type BsbVerse = { n: number; t: string };

export type BsbChapter = {
  book: string;
  chapter: number;
  verses: BsbVerse[];
};

// Successes only — scripture is immutable, but a failure (offline blip, 401
// mid-refresh, upstream hiccup) is not, so it must stay retryable on the next
// popover open instead of poisoning the chapter for the whole session.
const cache = new Map<string, BsbChapter>();
const inflight = new Map<string, Promise<BsbChapter | null>>();

const FETCH_TIMEOUT_MS = 8_000;

function cacheKey(book: string, chapter: number): string {
  return `${book.toUpperCase()}:${chapter}`;
}

/**
 * Load one BSB chapter. Dedupes concurrent requests and memoizes successes per
 * session. Returns null when the Worker can't supply text (offline, 401,
 * empty, network, hung response) — never cached, so the next open retries.
 */
export function fetchBsbChapter(
  book: string,
  chapter: number,
): Promise<BsbChapter | null> {
  const key = cacheKey(book, chapter);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;

  const req = (async (): Promise<BsbChapter | null> => {
    try {
      const res = await fetch(
        `/api/bible/bsb?book=${encodeURIComponent(book)}&chapter=${chapter}`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        book?: string;
        chapter?: number;
        verses?: BsbVerse[];
      };
      if (!Array.isArray(data.verses) || data.verses.length === 0) return null;
      const chapterPayload: BsbChapter = {
        book: typeof data.book === "string" ? data.book : book,
        chapter: typeof data.chapter === "number" ? data.chapter : chapter,
        verses: data.verses
          .filter(
            (v): v is BsbVerse =>
              !!v &&
              typeof v.n === "number" &&
              typeof v.t === "string" &&
              v.t.length > 0,
          )
          .map((v) => ({ n: v.n, t: v.t })),
      };
      if (chapterPayload.verses.length === 0) return null;
      cache.set(key, chapterPayload);
      return chapterPayload;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, req);
  return req;
}

/** Join verses in [start, end] (inclusive). Empty if the range is outside the chapter. */
export function joinVerseRange(
  verses: BsbVerse[],
  start: number,
  end: number,
): string {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return verses
    .filter((v) => v.n >= lo && v.n <= hi)
    .map((v) => v.t)
    .join(" ");
}
