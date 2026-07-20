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

// ---------------------------------------------------------------------------
// Daily calendar scaffold (issue #271): Daily > YYYY > Month > Week > Day.
//
// The scaffold keys join the daily-index kv beside the `container` sentinel,
// bare and shape-disambiguated (no prefixes): `2026` (year), `2026-07` (month),
// `2026-W29` (week), `2026-07-16` (day). Weeks are ISO 8601 (Monday start, ISO
// week number); a week is ATOMIC and its THURSDAY decides both the owning month
// AND year (ISO-consistent, equals majority-of-days) -- so the Jun 28-Jul 4
// straddle week lives whole under July. Ordering is chronological ascending at
// every level.
//
// All math here is pure and TZ-safe: keys parse via `Date.UTC` (never local-time
// `new Date("YYYY-MM-DD")`) and every step is exact UTC-midnight arithmetic (no
// DST slip). Nothing calls `Date.now()`; anything "relative" takes an explicit
// reference-key parameter (none needed yet).
// ---------------------------------------------------------------------------

/** Sentinel key for the "Daily" container row (daily-index.ts owns the runtime
 *  constant; duplicated here because this leaf is dependency-free). */
const CONTAINER_KEY = "container";

const YEAR_KEY_RE = /^\d{4}$/;
const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;
const WEEK_KEY_RE = /^(\d{4})-W(\d{2})$/;

const MS_PER_DAY = 86_400_000;

/** The kind of a daily-index scaffold key, or null for an unknown string. */
export type ScaffoldKind = "year" | "month" | "week" | "day" | "container";

/** Parse a `YYYY-MM-DD` key to its UTC midnight Date, or null on a malformed OR
 *  non-calendar key (the constructor round-trip rejects `2026-13-45`). UTC on
 *  purpose: scaffold math is calendar arithmetic, not a local wall clock.
 *  Exported so callers that format a day key (the week-range badge) parse it
 *  ONCE here rather than re-deriving the regex round-trip. */
export function dayKeyToUtc(dayKey: string): Date | null {
  const m = KEY_RE.exec(dayKey);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(y, mo - 1, day));
  if (
    d.getUTCFullYear() !== y ||
    d.getUTCMonth() !== mo - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

/** Format a UTC Date back to a `YYYY-MM-DD` day key (UTC fields, never local). */
function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The Thursday of the ISO week containing UTC date `d` (Mon-start weeks). This
 *  Thursday is what decides the ISO week-year, week number, and owning month. */
function isoThursday(d: Date): Date {
  const t = new Date(d.getTime());
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  return t;
}

/** The Thursday (UTC Date) of a `YYYY-Www` week key, or null when malformed or
 *  the week number doesn't exist in that ISO year (a W53 in a 52-week year
 *  round-trips into the next year and is rejected). */
function weekKeyToThursday(weekKey: string): Date | null {
  const m = WEEK_KEY_RE.exec(weekKey);
  if (!m) return null;
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const firstThursday = isoThursday(new Date(Date.UTC(isoYear, 0, 4)));
  const thursday = new Date(
    firstThursday.getTime() + (week - 1) * 7 * MS_PER_DAY,
  );
  if (thursday.getUTCFullYear() !== isoYear) return null; // week outside the year
  return thursday;
}

/**
 * Day key -> ISO week key: `2026-07-16` -> `2026-W29`. The week-year is the year
 * containing that week's Thursday (so a late-December day can land in the NEXT
 * year's W01, and an early-January day in the PREVIOUS year's W52/W53). Week
 * number is zero-padded W01..W53. Null on a malformed / non-calendar day key.
 */
export function dayKeyToWeekKey(dayKey: string): string | null {
  const d = dayKeyToUtc(dayKey);
  if (!d) return null;
  const thursday = isoThursday(d);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = isoThursday(new Date(Date.UTC(isoYear, 0, 4)));
  const week =
    1 +
    Math.round(
      (thursday.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY),
    );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Week key -> owning month key via the Thursday rule: `2026-W29` -> `2026-07`.
 * The Thursday of the week decides the month (and year), so an atomic straddle
 * week lives whole under one month. Null on a malformed / nonexistent week key.
 */
export function weekKeyToMonthKey(weekKey: string): string | null {
  const thursday = weekKeyToThursday(weekKey);
  if (!thursday) return null;
  const y = thursday.getUTCFullYear();
  const m = String(thursday.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Month key -> year key: `2026-07` -> `2026`. A named helper so callers don't
 *  string-slice. Null on a malformed month key or an out-of-range month. */
export function monthKeyToYearKey(monthKey: string): string | null {
  const m = MONTH_KEY_RE.exec(monthKey);
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return m[1] ?? null;
}

/**
 * Classify a daily-index key: `day` / `week` / `month` / `year`, the `container`
 * sentinel, or null for anything else (including a shape-shaped-but-invalid key
 * like `2026-13-01` or `2026-W99`). The shapes are disjoint by construction, so
 * order of the checks is immaterial.
 */
export function scaffoldKeyKind(key: string): ScaffoldKind | null {
  if (key === CONTAINER_KEY) return "container";
  if (KEY_RE.test(key)) return isValidDateKey(key) ? "day" : null;
  if (WEEK_KEY_RE.test(key)) return weekKeyToThursday(key) ? "week" : null;
  if (MONTH_KEY_RE.test(key)) return monthKeyToYearKey(key) ? "month" : null;
  if (YEAR_KEY_RE.test(key)) return "year";
  return null;
}

/**
 * The parent scaffold key of any scaffold/day key: day -> week -> month -> year
 * -> null (year is the top under the container). Null for the container sentinel
 * and unknown strings too -- the single walk a caller uses to build/climb the
 * Daily > Y > M > W > D chain.
 */
export function parentScaffoldKey(key: string): string | null {
  switch (scaffoldKeyKind(key)) {
    case "day":
      return dayKeyToWeekKey(key);
    case "week":
      return weekKeyToMonthKey(key);
    case "month":
      return monthKeyToYearKey(key);
    default:
      return null; // year (top), container, or unknown
  }
}

/**
 * Chronological comparator for two keys of the SAME kind (the caller's
 * responsibility) -- for sorted sibling insertion. Years numeric; weeks by ISO
 * year then week number; months and days are zero-padded fixed-width, so plain
 * lexical order IS chronological. Returns <0 / 0 / >0.
 */
export function compareScaffoldKeys(a: string, b: string): number {
  const wa = WEEK_KEY_RE.exec(a);
  const wb = WEEK_KEY_RE.exec(b);
  if (wa && wb) {
    const yearDiff = Number(wa[1]) - Number(wb[1]);
    return yearDiff !== 0 ? yearDiff : Number(wa[2]) - Number(wb[2]);
  }
  if (YEAR_KEY_RE.test(a) && YEAR_KEY_RE.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0; // month / day: lexical == chronological
}

/** Year label: `2026` -> "2026". A named seam (identity today) so callers read
 *  a label, not the raw key. */
export function yearLabel(yearKey: string): string {
  return yearKey;
}

/** Month label: `2026-07` -> "July" (en-US month name). Falls back to the raw
 *  key on a malformed / out-of-range month, the module's display convention. */
export function monthLabel(monthKey: string): string {
  const m = MONTH_KEY_RE.exec(monthKey);
  if (!m) return monthKey;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return monthKey;
  return new Date(Date.UTC(Number(m[1]), mo - 1, 1)).toLocaleDateString(
    "en-US",
    {
      month: "long",
      timeZone: "UTC",
    },
  );
}

/** Week label: `2026-W29` -> "Week 29" (no leading zero). Falls back to the raw
 *  key on a malformed / nonexistent week key. */
export function weekLabel(weekKey: string): string {
  const m = WEEK_KEY_RE.exec(weekKey);
  if (!m || !weekKeyToThursday(weekKey)) return weekKey;
  return `Week ${Number(m[2])}`;
}

/** The two-digit ISO week part of a week key: `2026-W29` -> `"29"`. The single
 *  source for pulling the week number out of a week key (callers add their own
 *  `W`/label chrome). Empty string on a malformed key. */
export function weekKeyWeekNumber(weekKey: string): string {
  return WEEK_KEY_RE.exec(weekKey)?.[2] ?? "";
}

/** The Monday and Sunday day-keys bounding an ISO week (for the badge to format
 *  a range). `2026-W29` -> `{ monday: "2026-07-13", sunday: "2026-07-19" }`.
 *  Null on a malformed / nonexistent week key. */
export function weekKeyToDayRange(
  weekKey: string,
): { monday: string; sunday: string } | null {
  const thursday = weekKeyToThursday(weekKey);
  if (!thursday) return null;
  return {
    monday: utcDayKey(new Date(thursday.getTime() - 3 * MS_PER_DAY)),
    sunday: utcDayKey(new Date(thursday.getTime() + 3 * MS_PER_DAY)),
  };
}

/** The seven day-keys of an ISO week, Monday..Sunday in order (the week strip's
 *  source of days -- ADR 0054). `2026-W29` -> `["2026-07-13", ..., "2026-07-19"]`.
 *  Null on a malformed / nonexistent week key. Derives from {@link
 *  weekKeyToDayRange} so the strip and the hierarchy agree on the week's bounds. */
export function weekKeyToDays(weekKey: string): string[] | null {
  const range = weekKeyToDayRange(weekKey);
  if (!range) return null;
  const days: string[] = [];
  for (let i = 0; i < 7; i++) days.push(addDays(range.monday, i));
  return days;
}

/** The week key `deltaWeeks` ISO weeks away (the strip's chevron paging -- ADR
 *  0054). `shiftWeekKey("2026-W29", 1)` -> `"2026-W30"`, `-1` -> `"2026-W28"`.
 *  Rides the shared ISO math (Monday of the week + whole-day arithmetic + the
 *  Thursday rule) so paging can never straddle two week nodes. Null on a
 *  malformed / nonexistent week key. */
export function shiftWeekKey(
  weekKey: string,
  deltaWeeks: number,
): string | null {
  const range = weekKeyToDayRange(weekKey);
  if (!range) return null;
  return dayKeyToWeekKey(addDays(range.monday, deltaWeeks * 7));
}

/** The full week/month/year chain a day key nests under (issue #271): the single
 *  Thursday-rule waterfall `day -> week -> month -> year`, or null when the day
 *  key can't be placed on the calendar. One home for what the client cascade, the
 *  migration plan, and both Worker planners were each open-coding. */
export interface ScaffoldChain {
  weekKey: string;
  monthKey: string;
  yearKey: string;
}
export function dayKeyToScaffoldChain(dayKey: string): ScaffoldChain | null {
  const weekKey = dayKeyToWeekKey(dayKey);
  const monthKey = weekKey ? weekKeyToMonthKey(weekKey) : null;
  const yearKey = monthKey ? monthKeyToYearKey(monthKey) : null;
  if (!weekKey || !monthKey || !yearKey) return null;
  return { weekKey, monthKey, yearKey };
}

/**
 * The scaffold kinds that are PROTECTED and, equivalently, the kinds a daily day
 * may legitimately nest under (issue #271, decision 6): the container plus every
 * intermediate calendar level. A `day` is CONTENT — never in this set. Both the
 * client `protects` predicate and the Worker's guard derive "is this protected"
 * from this one set, and the migration derives "is this day still inside the
 * scaffold" (vs relocated by the user) from it too, so the three can't drift.
 */
export const PROTECTED_SCAFFOLD_KINDS: ReadonlySet<ScaffoldKind> =
  new Set<ScaffoldKind>(["container", "year", "month", "week"]);

/** The canonical display text for a scaffold node: "2026" / "July" / "Week 29".
 *  Falls back to the raw key for a day / container / unknown (their text is
 *  owned elsewhere -- the full date, the container name). ONE dispatch, consumed
 *  by both the client cascade and the Worker's level emission. */
export function scaffoldLabel(key: string): string {
  switch (scaffoldKeyKind(key)) {
    case "year":
      return yearLabel(key);
    case "month":
      return monthLabel(key);
    case "week":
      return weekLabel(key);
    default:
      return key;
  }
}

/** A sibling as the placement logic sees it: its node id plus the daily-index
 *  key it maps to (null for a non-scaffold node -- e.g. a bullet outdented under
 *  a week, decision 9). */
export interface ScaffoldSibling {
  id: string;
  key: string | null;
}

/**
 * The id of the sibling AFTER which a fresh scaffold/day node keyed `newKey`
 * should be spliced to keep its SAME-KIND siblings in chronological ascending
 * order (issue #271, decision 4), or `null` to make it the first child. Only
 * same-kind siblings are compared, so non-scaffold children (an outdented
 * bullet) are skipped and never reordered.
 *
 * The ONE placement decision, shared by BOTH sides of the trust boundary (the
 * client cascade + the Worker's `planEnsureDaily`), so they can't diverge on the
 * same input. Robust to an unsorted list (best-effort during migration): picks
 * the greatest same-kind key strictly less than `newKey` as the predecessor;
 * when `newKey` precedes every same-kind sibling, lands immediately before the
 * earliest one; when there is no same-kind sibling at all, appends after the last
 * sibling. When same-kind siblings DO exist, a new greatest key chains after the
 * latest same-kind sibling — so it lands ahead of any trailing non-scaffold
 * children, never past them at the absolute tail.
 */
export function sortedInsertAfterId(
  siblings: ReadonlyArray<ScaffoldSibling>,
  newKey: string,
): string | null {
  const kind = scaffoldKeyKind(newKey);
  const sameKind = siblings.filter(
    (s): s is { id: string; key: string } =>
      s.key !== null && scaffoldKeyKind(s.key) === kind,
  );
  if (sameKind.length === 0) {
    return siblings.length ? siblings[siblings.length - 1]!.id : null;
  }

  // Predecessor: the same-kind sibling with the greatest key strictly < newKey.
  let predecessor: { id: string; key: string } | null = null;
  for (const s of sameKind) {
    if (compareScaffoldKeys(s.key, newKey) < 0) {
      if (!predecessor || compareScaffoldKeys(s.key, predecessor.key) > 0) {
        predecessor = s;
      }
    }
  }
  if (predecessor) return predecessor.id;

  // newKey precedes every same-kind sibling: splice it in immediately before the
  // earliest one (i.e. after whatever node currently precedes it in the list).
  let earliest = sameKind[0]!;
  for (const s of sameKind) {
    if (compareScaffoldKeys(s.key, earliest.key) < 0) earliest = s;
  }
  const idx = siblings.findIndex((s) => s.id === earliest.id);
  return idx > 0 ? siblings[idx - 1]!.id : null;
}
