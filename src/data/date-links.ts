// Date links (ADR 0038): the pure `[[YYYY-MM-DD]]` layer. A date token is a
// clickable pointer at that day's daily note -- the interior IS the daily-index
// key (localDateKey format, local calendar day; never toISOString), with an
// optional 24h time (`[[2026-07-08 14:00]]`) that is display + round-trip only,
// never identity. This module owns the grammar + parse/format/suggestion
// helpers (the src/data/tags.ts / node-links.ts split: core-known format,
// plugin-owned UX -- the chip + click-to-travel live in src/plugins/daily/).
//
// Deliberately dependency-free: consumed by the search flatten (inline-text.ts)
// and the `[[` picker without dragging the collection stack into `bun test`.

/**
 * Seam A regex fragment (no outer capture group -- the registry wraps it).
 * The bracket family with a strictly DATE-SHAPED interior, so it stays disjoint
 * from `NODE_LINK_PATTERN`'s id-shaped interiors (no collision possible) and
 * hand-typed near-misses (`[[July 8]]`, `[[2026-7-8]]`) stay literal text --
 * the node-links strictness discipline. The regex PROPOSES shape; the calendar
 * check in {@link parseDateLink} DISPOSES (`[[2026-13-45]]` renders literal).
 */
export const DATE_LINK_PATTERN =
  "\\[\\[\\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2})?\\]\\]";

// Internal, fresh-flagged `g` for the flatten's replace (mirrors node-links).
const DATE_LINK_REGEX = new RegExp(DATE_LINK_PATTERN, "g");

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One parsed token: the daily-index `key` (always the interior's first 10
 *  chars) plus the optional display-only `HH:MM` time. */
export interface DateLink {
  key: string;
  time: string | null;
}

/**
 * Local-time date key `YYYY-MM-DD`. Deliberately NOT `toISOString` (that's
 * UTC): the day boundary is the user's local midnight. The daily plugin's
 * `localDateKey` delegates here -- ONE implementation of the key format.
 */
export function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a `YYYY-MM-DD` key to a *local* Date at noon (a TZ-safe midpoint that
 *  never slips a day under DST). Null on a malformed OR non-calendar key --
 *  the constructor round-trip rejects `2026-13-45` (Date would roll it over). */
function parseDateKey(key: string): Date | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(y, mo - 1, day, 12);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

/** True iff `key` is a real local calendar day in `localDateKey` format. */
export function isValidDateKey(key: string): boolean {
  return parseDateKey(key) !== null;
}

/**
 * Parse one matched token (`[[2026-07-08]]` / `[[2026-07-08 14:00]]`) into its
 * key + optional time, or null when the shape-matched interior isn't a real
 * calendar day / clock time (regex proposes, this disposes -- the caller then
 * renders raw text, the route-bible discipline).
 */
export function parseDateLink(tok: string): DateLink | null {
  const interior = tok.slice(2, -2);
  const key = interior.slice(0, 10);
  if (!isValidDateKey(key)) return null;
  const time = interior.length > 10 ? interior.slice(11) : null;
  if (time !== null && !TIME_RE.test(time)) return null;
  return { key, time };
}

/** `key` shifted by `days` whole local days (DST-safe via the noon midpoint). */
export function addDays(key: string, days: number): string {
  const d = parseDateKey(key);
  if (!d) return key;
  d.setDate(d.getDate() + days);
  return localDateKey(d);
}

/**
 * The chip/badge-language label for a key: Today / Yesterday / Tomorrow, else a
 * short date ("Jul 8"). Speaks the same language as the daily badge
 * (`formatDayBadge`) so a date chip and a day note's badge can't disagree.
 */
export function formatDateLabel(key: string, today = localDateKey()): string {
  const d = parseDateKey(key);
  if (!d) return key;
  const t = parseDateKey(today);
  if (t) {
    const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
    if (diff === 0) return "Today";
    if (diff === -1) return "Yesterday";
    if (diff === 1) return "Tomorrow";
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The absolute, unambiguous date ("Tuesday, July 8, 2026") -- the chip's hover
 *  `title`, so a relative label always has its anchor one hover away. */
export function formatDateFull(key: string): string {
  const d = parseDateKey(key);
  if (!d) return key;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Flatten every date token in `text` to its display label ("Today", "Jul 8
 * 14:00") -- the search/display projection (wired into `flattenInline`), so a
 * Cmd+K row or breadcrumb never reads a raw `[[2026-07-08]]`. A shape-matched
 * but non-calendar token stays literal (it renders literal too).
 */
export function flattenDateLinks(text: string, today = localDateKey()): string {
  if (!text.includes("[[")) return text;
  return text.replace(DATE_LINK_REGEX, (tok) => {
    const parsed = parseDateLink(tok);
    if (!parsed) return tok;
    const label = formatDateLabel(parsed.key, today);
    return parsed.time ? `${label} ${parsed.time}` : label;
  });
}

/** One row the `[[` picker offers for a date-ish query. */
export interface DateSuggestion {
  key: string;
  label: string;
}

/**
 * The date rows for a `[[` picker query: today / tomorrow / yesterday on a
 * word-prefix match (>= 2 chars, the daily search-action threshold -- one char
 * would shove date rows above node matches on any "t"/"y" query), plus a fully
 * typed ISO date. No natural-language parsing (ADR 0038). Empty on a
 * non-date-ish query, which is also the caller's "should I pin dates" signal.
 */
export function dateSuggestions(
  query: string,
  today = localDateKey(),
): DateSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: DateSuggestion[] = [];
  if (q.length >= 2) {
    const relatives: [word: string, offset: number, label: string][] = [
      ["today", 0, "Today"],
      ["tomorrow", 1, "Tomorrow"],
      ["yesterday", -1, "Yesterday"],
    ];
    for (const [word, offset, label] of relatives) {
      if (word.startsWith(q)) out.push({ key: addDays(today, offset), label });
    }
  }
  if (KEY_RE.test(q) && isValidDateKey(q)) {
    out.push({ key: q, label: formatDateLabel(q, today) });
  }
  return out;
}
