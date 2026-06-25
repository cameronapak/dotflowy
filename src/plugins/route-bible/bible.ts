// The route-bible plugin's pure Scripture-reference layer (ADR 0026). A Bible
// reference lives literally in `node.text` -- never a stored field, exactly like
// a `#tag` or a link. `index.tsx` reuses BIBLE_REF_PATTERN to decorate the same
// runs as a clickable chip.
//
// This module is DOM-free and side-effect-free. grab-bcv does the real work:
// `tryParsePassage` validates a candidate against real chapter/verse caps, and
// `toResolverUrl` builds the route.bible link. We only detect candidates and
// gate them.

import { toResolverUrl, tryParsePassage } from "grab-bcv";

// The Seam-A token fragment: detection PROPOSES, the parser DISPOSES. Mirrors
// grab-bcv's own (internal, unexported) natural-text reference pattern, plus a
// leading boundary so a reference must start at text-start, whitespace, or `(`
// (so it never matches mid-word and `(John 3:16)` still chips).
//
//   (?<=^|[\s(])         start-of-text, whitespace, or an opening paren
//   (?:[1-3]\s*)?        optional book number -- "1 John", "2 Cor"
//   [A-Za-z]+            the book word
//   (?:\s+of\s+[A-Za-z]+)?  "Song of Solomon"
//   \s+\d+               a chapter -- REQUIRED, so a book name alone never chips
//   (?:(?::|\s)\d+(?:-\d+)?)?  an optional `:verse` (or space-verse) with range
//
// Deliberately liberal (case-insensitive, space-or-colon verse separator) per
// ADR 0026 -- it over-matches, and `resolveBibleRef` rejects anything grab-bcv
// won't parse ("Hello 3", "Revelation 99:99"). Tighten the regex later if the
// false positives ("Matthew 5 minutes") are felt in real use.
export const BIBLE_REF_PATTERN =
  "(?<=^|[\\s(])(?:[1-3]\\s*)?[A-Za-z]+(?:\\s+of\\s+[A-Za-z]+)?\\s+\\d+(?:(?::|\\s)\\d+(?:-\\d+)?)?";

/** The route.bible base every reference resolves against. */
const ROUTE_BIBLE_BASE = "https://route.bible";

/**
 * Validate a detected candidate and build its route.bible URL, or null if it
 * isn't a real reference (the caller then renders the raw text -- no chip).
 * `src=dotflowy` is sent for attribution; the translation is left to
 * route.bible's default (a per-user choice is deferred, ADR 0026).
 */
export function resolveBibleRef(token: string): { url: string } | null {
  const parsed = tryParsePassage(token);
  if (!parsed.ok) return null;
  try {
    return {
      url: toResolverUrl(ROUTE_BIBLE_BASE, parsed.value, {
        query: { src: "dotflowy" },
      }),
    };
  } catch {
    return null;
  }
}
