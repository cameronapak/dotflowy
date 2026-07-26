// Cmd+K "go to date" NL parse (ADR 0055 / 0057) + the stricter `[[` picker gate
// (ADR 0038 amend). Client-only — chrono must not land in the Worker (MCP
// already takes ISO; "tomorrow" is the user's local calendar).
// `date-links.ts` stays dependency-free for Worker share.

import * as chrono from "chrono-node/en";

import {
  addDays,
  dateSuggestions,
  formatDateFull,
  formatDateLabel,
  isValidDateKey,
  localDateKey,
  resolvePeriod,
  resolveWeekdayStem,
  type DateSuggestion,
  type PeriodQualifier,
  type PeriodUnit,
} from "./date-links";

const ISO_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_UNITS: PeriodUnit[] = ["week", "month", "year"];

/** Word-prefix relatives (parity with `dateSuggestions` + the old today-only
 *  searchAction). Order is load-bearing: "to" must hit today before tomorrow. */
const RELATIVE_PREFIXES: [word: string, offset: number][] = [
  ["today", 0],
  ["tomorrow", 1],
  ["yesterday", -1],
];

/** One Cmd+K / catalog row: a day key or an ISO scaffold key. */
export type GoToDateHit = {
  key: string;
  /** Switcher row label, e.g. "Go to Wednesday, August 12, 2026". */
  label: string;
  /** `day` (default) or scaffold period for dual-resolve (ADR 0057). */
  kind: "day" | PeriodUnit;
};

/** Past-leaning phrases must not use chrono's `forwardDate` — it rewrites
 *  "last Friday" into the *next* Friday. Bare weekdays / "next …" still prefer
 *  the future when the query has no past marker. */
function wantsForwardDate(query: string): boolean {
  return !/\b(last|ago|previous|past)\b/i.test(query);
}

type ChronoHit = NonNullable<ReturnType<typeof chrono.parse>[number]>;

/** Whole-query chrono parse, or null. Shared by Cmd+K and the picker gate. */
function parseChronoWholeQuery(q: string, now: Date): ChronoHit | null {
  const hits = chrono.parse(q, now, {
    forwardDate: wantsForwardDate(q),
  });
  const hit = hits[0];
  if (!hit || hit.index !== 0) return null;
  // Whole-query match (trailing junk means this isn't a go-to-date phrase).
  if (hit.text.trim().length !== q.length) return null;
  return hit;
}

function dayHit(key: string, today: string): GoToDateHit {
  return { key, label: goToDateLabel(key, today), kind: "day" };
}

function scaffoldHit(
  scaffoldKey: string,
  kind: PeriodUnit,
  qualifier: PeriodQualifier,
): GoToDateHit {
  return {
    key: scaffoldKey,
    label: `Go to ${periodCatalogLabel(qualifier, kind)}`,
    kind,
  };
}

function periodCatalogLabel(
  qualifier: PeriodQualifier,
  unit: PeriodUnit,
): string {
  const prefix = qualifier === "next" ? "Next" : "Last";
  return `${prefix} ${unit}`;
}

/**
 * Catalog trio (ADR 0057): when the query is exactly `next`/`last` (optional
 * trailing space) or a suffix that still prefixes week/month/year — never bare
 * `ne`. Returns matching units in week → month → year order.
 */
export function periodCatalogUnits(
  query: string,
): { qualifier: PeriodQualifier; units: PeriodUnit[] } | null {
  const q = query.trim().toLowerCase();
  const m = /^(next|last)(?:\s+(.*))?$/.exec(q);
  if (!m) return null;
  const qualifier = m[1] as PeriodQualifier;
  const rest = (m[2] ?? "").trim();
  // Full-word gate is the regex (`next`|`last`); `ne` / `la` never match.
  if (!rest) return { qualifier, units: [...PERIOD_UNITS] };
  const units = PERIOD_UNITS.filter((u) => u.startsWith(rest));
  return units.length ? { qualifier, units } : null;
}

/** Owned weekday prefix (≥3 chars), optional next/last. Shared Cmd+K + `[[`. */
function parseOwnedWeekday(q: string, today: string): string | null {
  const m = /^(?:(next|last)\s+)?([a-z]+)$/i.exec(q);
  if (!m) return null;
  const qualifier =
    (m[1]?.toLowerCase() as PeriodQualifier | undefined) ?? null;
  return resolveWeekdayStem(m[2]!, qualifier, today);
}

/** Exact `next week` / `last month` / … (full unit word). */
function parseExactPeriod(
  q: string,
  today: string,
): ReturnType<typeof resolvePeriod> {
  const m = /^(next|last)\s+(week|month|year)$/i.exec(q);
  if (!m) return null;
  return resolvePeriod(
    m[1]!.toLowerCase() as PeriodQualifier,
    m[2]!.toLowerCase() as PeriodUnit,
    today,
  );
}

/**
 * Parse a Cmd+K query into one or more go-to targets (day or scaffold). Catalog
 * trio may return up to three rows; other paths return 0–1. Relatives → owned
 * weekday → period/catalog → ISO → chrono.
 */
export function parseGoToDateTargets(
  query: string,
  now = new Date(),
): GoToDateHit[] {
  const q = query.trim();
  if (q.length < 2) return [];

  const today = localDateKey(now);
  const lower = q.toLowerCase();

  for (const [word, offset] of RELATIVE_PREFIXES) {
    if (word.startsWith(lower)) {
      return [dayHit(addDays(today, offset), today)];
    }
  }

  // Exact period before catalog so `next week` is one scaffold hit, not three.
  const exact = parseExactPeriod(lower, today);
  if (exact) {
    const qualifier = lower.startsWith("next") ? "next" : "last";
    return [scaffoldHit(exact.scaffoldKey, exact.scaffoldKind, qualifier)];
  }

  const catalog = periodCatalogUnits(q);
  if (catalog) {
    const hits: GoToDateHit[] = [];
    for (const unit of catalog.units) {
      const resolved = resolvePeriod(catalog.qualifier, unit, today);
      if (!resolved) continue;
      hits.push({
        key: resolved.scaffoldKey,
        label: `Go to ${periodCatalogLabel(catalog.qualifier, unit)}`,
        kind: unit,
      });
    }
    if (hits.length) return hits;
  }

  const weekdayKey = parseOwnedWeekday(lower, today);
  if (weekdayKey) return [dayHit(weekdayKey, today)];

  if (ISO_KEY_RE.test(q)) {
    if (!isValidDateKey(q)) return [];
    return [dayHit(q, today)];
  }

  const hit = parseChronoWholeQuery(q, now);
  if (!hit) return [];

  const key = localDateKey(hit.start.date());
  if (!isValidDateKey(key)) return [];
  return [dayHit(key, today)];
}

/**
 * Parse a Cmd+K query into a local daily-index key, or null when it isn't a
 * date phrase. Convenience over {@link parseGoToDateTargets} (first hit).
 */
export function parseGoToDateQuery(
  query: string,
  now = new Date(),
): GoToDateHit | null {
  return parseGoToDateTargets(query, now)[0] ?? null;
}

/**
 * Stricter than {@link parseGoToDateQuery} for the `[[` picker (ADR 0038 /
 * 0057): ISO, relatives, owned weekdays (incl. next/last), period →
 * period-start **day**, or chrono that is calendar-complete (day-of-month,
 * explicit year, **or weekday**). Bare `April` → null. Always returns day keys
 * (never scaffold).
 */
export function parseDatePickerQuery(
  query: string,
  now = new Date(),
): DateSuggestion | null {
  const hits = parseDatePickerTargets(query, now);
  return hits[0] ?? null;
}

/** `[[` picker targets (always day keys). Catalog trio + single resolves. */
export function parseDatePickerTargets(
  query: string,
  now = new Date(),
): DateSuggestion[] {
  const q = query.trim();
  if (q.length < 2) return [];

  const today = localDateKey(now);
  const lower = q.toLowerCase();

  for (const [word, offset] of RELATIVE_PREFIXES) {
    if (word.startsWith(lower)) {
      const key = addDays(today, offset);
      return [{ key, label: pickerDateLabel(key, today) }];
    }
  }

  const exact = parseExactPeriod(lower, today);
  if (exact) {
    return [
      {
        key: exact.periodStartDay,
        label: pickerDateLabel(exact.periodStartDay, today),
      },
    ];
  }

  const catalog = periodCatalogUnits(q);
  if (catalog) {
    const out: DateSuggestion[] = [];
    for (const unit of catalog.units) {
      const resolved = resolvePeriod(catalog.qualifier, unit, today);
      if (!resolved) continue;
      out.push({
        key: resolved.periodStartDay,
        label: periodCatalogLabel(catalog.qualifier, unit),
      });
    }
    if (out.length) return out;
  }

  const weekdayKey = parseOwnedWeekday(lower, today);
  if (weekdayKey) {
    return [{ key: weekdayKey, label: pickerDateLabel(weekdayKey, today) }];
  }

  if (ISO_KEY_RE.test(q)) {
    if (!isValidDateKey(q)) return [];
    return [{ key: q, label: pickerDateLabel(q, today) }];
  }

  const hit = parseChronoWholeQuery(q, now);
  if (!hit) return [];
  // Calendar-complete: day-of-month, year, OR weekday (bare months stay out).
  const certain =
    hit.start.isCertain("day") ||
    hit.start.isCertain("year") ||
    hit.start.isCertain("weekday");
  if (!certain) return [];

  const key = localDateKey(hit.start.date());
  if (!isValidDateKey(key)) return [];
  return [{ key, label: pickerDateLabel(key, today) }];
}

/**
 * Date rows for the `[[` picker: relatives + ISO from {@link dateSuggestions},
 * plus gated NL ({@link parseDatePickerTargets}). Deduped by key.
 */
export function pickerDateSuggestions(
  query: string,
  now = new Date(),
): DateSuggestion[] {
  const today = localDateKey(now);
  const base = dateSuggestions(query, today);
  const nl = parseDatePickerTargets(query, now);
  const seen = new Set(base.map((s) => s.key));
  const merged = [...base];
  for (const s of nl) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    merged.push(s);
  }
  // Catalog rows keep their "Next week" labels; day rows use picker labels.
  return merged.map((s) => {
    if (/^(Next|Last) (week|month|year)$/.test(s.label)) return s;
    return { key: s.key, label: pickerDateLabel(s.key, today) };
  });
}

/** `[[` picker primary label: near relatives stay short; everything else is
 *  the full weekday date Cmd+K / day titles use ({@link formatDateFull}). */
export function pickerDateLabel(key: string, today = localDateKey()): string {
  const short = formatDateLabel(key, today);
  if (short === "Today" || short === "Yesterday" || short === "Tomorrow") {
    return short;
  }
  return formatDateFull(key);
}

/** Near relatives stay short ("Go to Tomorrow"); everything else uses the full
 *  weekday date the day node's title uses. */
export function goToDateLabel(key: string, today = localDateKey()): string {
  return `Go to ${pickerDateLabel(key, today)}`;
}
