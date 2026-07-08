// The route-bible plugin's pure Scripture-reference layer (ADR 0001). A Bible
// reference lives literally in `node.text` -- never a stored field, exactly like
// a `#tag` or a link. `index.tsx` reuses BIBLE_REF_PATTERN to decorate the same
// runs as a clickable chip.
//
// This module is DOM-free and side-effect-free. grab-bcv does the real work:
// `tryParsePassage` validates a candidate against real chapter/verse caps, and
// `toResolverUrl` builds the route.bible link. We only detect candidates and
// gate them.

import {
  autocompletePassage,
  OSIS_BOOK_NAMES,
  toDisplayRef,
  toResolverUrl,
  tryParsePassage,
  type AutocompletePassageSuggestion,
  type OsisBookCode,
} from "grab-bcv";
import { LINK_PATTERN, encodeUrlForMarkdown } from "../../data/links";
import { spliceToken } from "../token-splice";

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
// ADR 0001 -- it over-matches, and `resolveBibleRef` rejects anything grab-bcv
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
 * route.bible's default (a per-user choice is deferred, ADR 0001).
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

export function normalizeBibleRef(
  token: string,
): { label: string; url: string } | null {
  const parsed = tryParsePassage(token);
  if (!parsed.ok) return null;
  try {
    return {
      label: toDisplayRef(parsed.value),
      url: toResolverUrl(ROUTE_BIBLE_BASE, parsed.value, {
        query: { src: "dotflowy" },
      }),
    };
  } catch {
    return null;
  }
}

export function suggestBibleRefs(
  input: string,
  limit = 5,
): AutocompletePassageSuggestion[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  return autocompletePassage(trimmed, { limit }).filter(
    (suggestion) => suggestion.insertText !== trimmed,
  );
}

export function formatStructuredBibleRef(args: {
  book: OsisBookCode;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
}): string {
  const base = `${OSIS_BOOK_NAMES[args.book]} ${args.chapter}`;
  if (args.startVerse == null) return base;
  if (args.endVerse != null && args.endVerse > args.startVerse) {
    return `${base}:${args.startVerse}-${args.endVerse}`;
  }
  return `${base}:${args.startVerse}`;
}

export function replaceBibleRefToken(
  text: string,
  oldToken: string,
  newToken: string,
): string | null {
  // Delegates to the shared spliceToken (src/plugins/token-splice.ts).
  return spliceToken(text, oldToken, newToken);
}

const CODE_RUN_PATTERN = "`[^`\\n]+`";
const MARKDOWN_LINK_OR_CODE_RE = () =>
  new RegExp(`${LINK_PATTERN}|${CODE_RUN_PATTERN}`, "g");

function protectedRanges(text: string): Array<{ start: number; end: number }> {
  return Array.from(text.matchAll(MARKDOWN_LINK_OR_CODE_RE()), (m) => {
    const start = m.index ?? 0;
    return { start, end: start + m[0].length };
  });
}

function isProtected(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => start < r.end && end > r.start);
}

/**
 * Convert valid route-bible chip sources into ordinary markdown links for
 * export. Stored text stays plain ("John 3:16"); copied markdown becomes
 * readable and portable ("[John 3:16](https://route.bible/...)").
 */
export function bibleRefsToMarkdownLinks(text: string): string {
  const ranges = protectedRanges(text);
  return text.replace(new RegExp(BIBLE_REF_PATTERN, "g"), (token, offset: number) => {
    const start = offset;
    const end = start + token.length;
    if (isProtected(start, end, ranges)) return token;
    const ref = resolveBibleRef(token);
    return ref ? `[${token}](${encodeUrlForMarkdown(ref.url)})` : token;
  });
}

/** Return the route.bible URL whose source reference contains or touches
 *  `offset`, in contentEditable SOURCE space. Atomic chips can only place the
 *  caret before or after themselves, so the end boundary is intentionally
 *  openable. A ref inside a link or code token never chips (those tokens win
 *  precedence in the registry), so it must not open here either. */
export function bibleRefUrlAtOffset(text: string, offset: number): string | null {
  const ranges = protectedRanges(text);
  for (const m of text.matchAll(new RegExp(BIBLE_REF_PATTERN, "g"))) {
    const start = m.index ?? 0;
    const token = m[0] ?? "";
    const end = start + token.length;
    if (offset < start || offset > end) continue;
    if (isProtected(start, end, ranges)) continue;
    return resolveBibleRef(token)?.url ?? null;
  }
  return null;
}
