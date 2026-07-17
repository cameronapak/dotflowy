// Daily calendar scaffold (issue #271): the PURE layer for the
// Daily > YYYY > Month > Week > Day hierarchy. Deliberately dependency-free of
// the collection / React stack (imports only the pure date-links math + the pure
// tree helpers), so every decision here -- where a sorted sibling lands, and the
// one-time flat->nested migration plan -- is unit-testable under `bun test`
// without mocking the world. The effectful cascade (atomic claims, structural
// writes) lives in index.tsx and consumes these.
//
// The chronological-ascending placement decision (`sortedInsertAfterId`,
// decision 4) is SHARED with the Worker, so it lives in the dependency-free
// `date-links.ts` and is re-exported here for the client callers + tests. This
// module owns:
//   - `planDailyMigration` + `DailyMigrationPlan`: the derivable one-time
//     migration (decision 8) -- which scaffold nodes to mint (parents-first) and
//     which days to reparent, in ascending order. The runner resolves ids and
//     applies the moves.
//   - the week-badge date-range formatting.

import type { TreeIndex } from "../../data/tree";

import {
  PROTECTED_SCAFFOLD_KINDS,
  addDays,
  compareScaffoldKeys,
  dayKeyToScaffoldChain,
  dayKeyToUtc,
  dayKeyToWeekKey,
  localDateKey,
  scaffoldKeyKind,
  weekKeyToDayRange,
  weekLabel,
} from "../../data/date-links";

// --- sorted sibling placement -----------------------------------------------
// The placement decision now lives in `date-links.ts` (shared with the Worker,
// decision 9). Re-exported so existing client callers + tests import it here.
export {
  sortedInsertAfterId,
  type ScaffoldSibling,
} from "../../data/date-links";

// --- week badge formatting --------------------------------------------------

/** Parse a `YYYY-MM-DD` day key to a short en-US month + day-of-month, or null
 *  on a malformed key. UTC to match the module's calendar-arithmetic convention
 *  (never a local wall clock); parses via the shared `dayKeyToUtc` so the key
 *  round-trip isn't re-implemented here. */
function shortDayParts(dayKey: string): { month: string; day: string } | null {
  const d = dayKeyToUtc(dayKey);
  if (!d) return null;
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
 * Derive the migration from the daily-index day mappings + the live tree. Pure:
 * no claims, no writes -- the runner turns this into atomic claims + one
 * structural batch.
 *
 * Candidates come from `dayRows` (the daily-index day mappings), NOT a full
 * outline scan (finding 7): a legacy container may hold thousands of nodes, but
 * only the mapped days can migrate. `keyOf` is an O(1) reverse lookup (the
 * persistent `daily-index.ts` map) used ONLY to classify a day's current PARENT.
 *
 * A day is IN SCOPE only when its current parent is the container or a scaffold
 * node (year/month/week) -- a day the USER relocated elsewhere (dragged under a
 * normal bullet) is left alone (finding 1). Already-nested days stay in `days`
 * (a re-parent no-op) so a half-migrated tree heals on re-entry.
 */
/** True when every ancestor from `day`'s parent up to (and reaching) the Daily
 *  `containerId` is a protected scaffold node or the container itself. Walking
 *  the FULL chain -- not just the immediate parent -- is what keeps a day whose
 *  scaffold subtree the user relocated OUTSIDE Daily out of migration scope
 *  (finding 5): protection blocks delete/blank, not move, so a whole week can be
 *  dragged elsewhere; its days still map to scaffold keys, but their chain no
 *  longer reaches `containerId`. Also leaves a day filed under a user's own
 *  (non-scaffold) bullet inside Daily alone. A cycle guard bounds the walk. */
export function inScaffoldScope(
  index: TreeIndex,
  day: { id: string; parentId?: string | null },
  containerId: string,
  keyOf: (nodeId: string) => string | null,
): boolean {
  const seen = new Set<string>([day.id]);
  let parentId = day.parentId;
  while (parentId) {
    if (parentId === containerId) return true;
    if (seen.has(parentId)) return false; // cycle guard
    seen.add(parentId);
    const key = keyOf(parentId);
    const kind = key ? scaffoldKeyKind(key) : null;
    if (kind === null || !PROTECTED_SCAFFOLD_KINDS.has(kind)) return false;
    parentId = index.byId.get(parentId)?.parentId ?? null;
  }
  return false;
}

export function planDailyMigration(
  index: TreeIndex,
  containerId: string,
  dayRows: ReadonlyArray<{ key: string; nodeId: string }>,
  keyOf: (nodeId: string) => string | null,
): DailyMigrationPlan {
  const days: DayPlacement[] = [];
  const years = new Set<string>();
  const months = new Set<string>();
  const weeks = new Set<string>();
  let needed = false;

  for (const row of dayRows) {
    if (scaffoldKeyKind(row.key) !== "day") continue;
    const node = index.byId.get(row.nodeId);
    if (!node) continue; // a mapping pointing at a node not in the tree
    // In scope only when the day's WHOLE ancestor chain stays inside the Daily
    // scaffold and reaches the container -- a day (or a whole scaffold subtree)
    // the user relocated elsewhere is left alone (finding 1 + finding 5).
    if (!inScaffoldScope(index, node, containerId, keyOf)) continue;
    const chain = dayKeyToScaffoldChain(row.key);
    if (!chain) continue;
    days.push({ nodeId: node.id, dayKey: row.key, weekKey: chain.weekKey });
    years.add(chain.yearKey);
    months.add(chain.monthKey);
    weeks.add(chain.weekKey);
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
