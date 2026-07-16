// Daily calendar scaffold (issue #271): the PURE layer for the
// Daily > YYYY > Month > Week > Day hierarchy. Deliberately dependency-free of
// the collection / React stack (imports only the pure date-links math + the pure
// tree helpers), so every decision here -- where a sorted sibling lands, and the
// one-time flat->nested migration plan -- is unit-testable under `bun test`
// without mocking the world. The effectful cascade (atomic claims, structural
// writes) lives in index.tsx and consumes these.
//
// Two pure pieces:
//   - `sortedInsertAfterId`: the chronological-ascending placement decision
//     (decision 4). Same-kind siblings only, so a bullet outdented under a week
//     (decision 9) never disturbs the day order.
//   - `planDailyMigration` + `DailyMigrationPlan`: the derivable one-time
//     migration (decision 8) -- which scaffold nodes to mint (parents-first) and
//     which days to reparent, in ascending order. The runner resolves ids and
//     applies the moves.

import type { TreeIndex } from "../../data/tree";

import {
  addDays,
  compareScaffoldKeys,
  dayKeyToWeekKey,
  localDateKey,
  monthKeyToYearKey,
  scaffoldKeyKind,
  weekKeyToDayRange,
  weekKeyToMonthKey,
  weekLabel,
} from "../../data/date-links";

// --- sorted sibling placement -----------------------------------------------

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
 * order (decision 4), or `null` to make it the first child. Only same-kind
 * siblings are compared, so non-scaffold children (an outdented bullet) are
 * skipped and never reordered.
 *
 * Robust to an unsorted list (best-effort during migration): picks the greatest
 * same-kind key strictly less than `newKey` as the predecessor; when `newKey`
 * precedes every same-kind sibling, lands immediately before the earliest one;
 * when there is no same-kind sibling at all, appends at the end (keeping any
 * leading non-scaffold children on top).
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

// --- week badge formatting --------------------------------------------------

/** Parse a `YYYY-MM-DD` day key to a short en-US month + day-of-month, or null
 *  on a malformed key. UTC to match the module's calendar-arithmetic convention
 *  (never a local wall clock). */
function shortDayParts(dayKey: string): { month: string; day: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return {
    month: d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    day: String(d.getUTCDate()),
  };
}

/**
 * The date-range label for a week badge: `2026-W29` -> "Jul 13 – 19", or
 * "Dec 29 – Jan 4" when the week straddles a month boundary. Falls back to the
 * plain week label on a malformed / nonexistent week key.
 */
export function formatWeekRange(weekKey: string): string {
  const range = weekKeyToDayRange(weekKey);
  const mon = range && shortDayParts(range.monday);
  const sun = range && shortDayParts(range.sunday);
  if (!mon || !sun) return weekLabel(weekKey);
  return mon.month === sun.month
    ? `${mon.month} ${mon.day} – ${sun.day}`
    : `${mon.month} ${mon.day} – ${sun.month} ${sun.day}`;
}

/**
 * The relative label for a week badge -- "This week" / "Last week" -- or null
 * beyond that. "Now" derives from `localDateKey()` (local midnight, never
 * `toISOString`) then `dayKeyToWeekKey`, so the anchor matches the day badge's.
 */
export function formatWeekRelative(
  weekKey: string,
  today = localDateKey(),
): string | null {
  if (weekKey === dayKeyToWeekKey(today)) return "This week";
  if (weekKey === dayKeyToWeekKey(addDays(today, -7))) return "Last week";
  return null;
}

// --- one-time flat -> nested migration plan ---------------------------------

/** One day the migration must reparent, with the week it belongs under. */
export interface DayPlacement {
  nodeId: string;
  dayKey: string;
  weekKey: string;
}

/** The derived migration (decision 8). Pure over the current tree + the daily
 *  index reverse map; the runner resolves scaffold node ids and applies it. */
export interface DailyMigrationPlan {
  /** True when a legacy flat day (a mapped day sitting DIRECTLY under the
   *  container) exists -- the automatic trigger. A fully-nested outline (or a
   *  brand-new empty account) yields false, so the runner no-ops. */
  needed: boolean;
  /** Distinct scaffold keys the plan requires, PARENTS-FIRST (years ascending,
   *  then months, then weeks), so the runner can create each under an
   *  already-materialized parent. */
  scaffoldKeys: string[];
  /** Every mapped day, ascending by date, with its owning week key. Includes
   *  already-nested days (their move is a harmless no-op), so a partially
   *  migrated outline heals on re-entry. */
  days: DayPlacement[];
}

/**
 * Derive the migration from the live tree + the daily-index reverse map
 * (`keyOf(nodeId)` -> the key that node is mapped to, or null). Pure: no claims,
 * no writes -- the runner turns this into atomic claims + one structural batch.
 */
export function planDailyMigration(
  index: TreeIndex,
  containerId: string,
  keyOf: (nodeId: string) => string | null,
): DailyMigrationPlan {
  const days: DayPlacement[] = [];
  const years = new Set<string>();
  const months = new Set<string>();
  const weeks = new Set<string>();
  let needed = false;

  for (const node of index.byId.values()) {
    const key = keyOf(node.id);
    if (!key || scaffoldKeyKind(key) !== "day") continue;
    const weekKey = dayKeyToWeekKey(key);
    const monthKey = weekKey ? weekKeyToMonthKey(weekKey) : null;
    const yearKey = monthKey ? monthKeyToYearKey(monthKey) : null;
    if (!weekKey || !monthKey || !yearKey) continue;
    days.push({ nodeId: node.id, dayKey: key, weekKey });
    years.add(yearKey);
    months.add(monthKey);
    weeks.add(weekKey);
    // The legacy flat shape parents every day directly under the container.
    if (node.parentId === containerId) needed = true;
  }

  days.sort((a, b) => compareScaffoldKeys(a.dayKey, b.dayKey));
  const scaffoldKeys = [
    ...[...years].sort(compareScaffoldKeys),
    ...[...months].sort(compareScaffoldKeys),
    ...[...weeks].sort(compareScaffoldKeys),
  ];
  return { needed, scaffoldKeys, days };
}
