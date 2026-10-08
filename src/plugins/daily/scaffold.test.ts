import { describe, expect, test } from "bun:test";

import type { WeekStart } from "../../data/date-links";

import { buildTreeIndex, createNode } from "../../data/tree";
import {
  formatWeekRange,
  formatWeekRelative,
  isOrphanMappedDay,
  planDailyMigration,
} from "./scaffold";

test.each([
  ["week:2026-07-13", "Jul 13–19"], // within one month
  ["week:2025-12-29", "Dec 29, 2025–Jan 4, 2026"], // across a year boundary
  ["2025-W53", "2025-W53"], // nonexistent week -> the raw label
])("formatWeekRange(%s) -> %s", (week, expected) => {
  expect(formatWeekRange(week)).toBe(expected);
});

test.each<[string, WeekStart, string | null]>([
  ["week:2026-07-13", "monday", "This week"],
  ["week:2026-07-06", "monday", "Last week"],
  ["week:2026-06-29", "monday", null],
  ["week:2026-07-20", "monday", null],
  ["week:2026-07-12", "sunday", "This week"],
])(
  "formatWeekRelative(%s, %s) on 2026-07-16 -> %p",
  (week, weekStart, expected) => {
    expect(formatWeekRelative(week, "2026-07-16", weekStart)).toBe(expected);
  },
);

describe("planDailyMigration", () => {
  /** Build a keyOf() over an explicit id -> key map. */
  const keyOf = (map: Record<string, string>) => (id: string) =>
    map[id] ?? null;
  /** The daily-index DAY rows (the migration's candidate source), derived from
   *  the id -> key map so a test declares the mappings once. */
  const dayRows = (map: Record<string, string>) =>
    Object.entries(map).map(([nodeId, key]) => ({ key, nodeId }));

  test("flat days -> needed, ascending days, parents-first scaffold keys", () => {
    const nodes = [
      createNode({ id: "c", text: "Daily" }),
      createNode({ id: "d1", parentId: "c" }), // 2026-07-16
      createNode({ id: "d2", parentId: "c" }), // 2026-07-08
      createNode({ id: "d3", parentId: "c" }), // 2025-12-30; fourth day is in 2026
    ];
    const map = {
      c: "container",
      d1: "2026-07-16",
      d2: "2026-07-08",
      d3: "2025-12-30",
    };
    const plan = planDailyMigration(
      buildTreeIndex(nodes),
      "c",
      dayRows(map),
      keyOf(map),
    );

    expect(plan.needed).toBe(true);
    // Days ascending by date, each carrying its owning week.
    expect(plan.days).toEqual([
      { nodeId: "d3", dayKey: "2025-12-30", weekKey: "week:2025-12-29" },
      { nodeId: "d2", dayKey: "2026-07-08", weekKey: "week:2026-07-06" },
      { nodeId: "d1", dayKey: "2026-07-16", weekKey: "week:2026-07-13" },
    ]);
    // Scaffold keys are parents-first: years, then months, then weeks.
    // 2025-12-30's fourth day is 2026-01-01, so it rolls into year 2026.
    expect(plan.scaffoldKeys).toEqual([
      "2026",
      "2026-01",
      "2026-07",
      "week:2025-12-29",
      "week:2026-07-06",
      "week:2026-07-13",
    ]);
  });

  test("fully nested days -> not needed (idempotent re-entry)", () => {
    const nodes = [
      createNode({ id: "c", text: "Daily" }),
      createNode({ id: "y", parentId: "c" }),
      createNode({ id: "w", parentId: "y" }),
      createNode({ id: "d1", parentId: "w" }),
    ];
    const map = {
      c: "container",
      y: "2026",
      w: "week:2026-07-13",
      d1: "2026-07-16",
    };
    const plan = planDailyMigration(
      buildTreeIndex(nodes),
      "c",
      dayRows(map),
      keyOf(map),
    );
    expect(plan.needed).toBe(false);
    // Still lists the day (a re-parent no-op) so a half-migrated tree heals.
    expect(plan.days.map((d) => d.dayKey)).toEqual(["2026-07-16"]);
  });

  test("brand-new empty account -> nothing to do", () => {
    const nodes = [createNode({ id: "c", text: "Daily" })];
    const plan = planDailyMigration(
      buildTreeIndex(nodes),
      "c",
      dayRows({ c: "container" }),
      keyOf({ c: "container" }),
    );
    expect(plan.needed).toBe(false);
    expect(plan.days).toEqual([]);
    expect(plan.scaffoldKeys).toEqual([]);
  });

  test("a user-relocated day (parked under a normal bullet) is left alone (finding 1)", () => {
    // The user dragged a mapped day out of the Daily scaffold, under a plain
    // note. It must NOT migrate -- only days still inside the scaffold do.
    const nodes = [
      createNode({ id: "c", text: "Daily" }),
      createNode({ id: "note", text: "Project" }), // a normal top-level bullet
      createNode({ id: "moved", parentId: "note" }), // 2026-07-16, relocated here
      createNode({ id: "flat", parentId: "c" }), // 2026-07-08, still flat
    ];
    const map = {
      c: "container",
      moved: "2026-07-16",
      flat: "2026-07-08",
      // `note` has no mapping -> keyOf returns null -> not a scaffold parent.
    };
    const plan = planDailyMigration(
      buildTreeIndex(nodes),
      "c",
      dayRows(map),
      keyOf(map),
    );
    expect(plan.needed).toBe(true); // the flat day still triggers it
    // Only the in-scaffold flat day is planned; the relocated one is skipped.
    expect(plan.days.map((d) => d.nodeId)).toEqual(["flat"]);
  });

  test("a day already nested under a week is in scope (no-op move heals re-entry)", () => {
    const nodes = [
      createNode({ id: "c", text: "Daily" }),
      createNode({ id: "y", parentId: "c" }),
      createNode({ id: "m", parentId: "y" }),
      createNode({ id: "w", parentId: "m" }),
      createNode({ id: "nested", parentId: "w" }), // 2026-07-16, correctly placed
      createNode({ id: "flat", parentId: "c" }), // 2026-07-08, still flat
    ];
    const map = {
      c: "container",
      y: "2026",
      m: "2026-07",
      w: "week:2026-07-13",
      nested: "2026-07-16",
      flat: "2026-07-08",
    };
    const plan = planDailyMigration(
      buildTreeIndex(nodes),
      "c",
      dayRows(map),
      keyOf(map),
    );
    expect(plan.needed).toBe(true);
    // Both days are in scope; the already-nested one rides along as a no-op move.
    expect(plan.days.map((d) => d.nodeId).sort()).toEqual(["flat", "nested"]);
  });

  test("orphan mapped day (dangling parent) is in scope and needed", () => {
    // After a partial upgraded-sync cutover the day nodes can survive while their
    // week parents are gone — parentId dangles. inScaffoldScope alone would skip
    // them forever; orphans must reattach.
    const nodes = [
      createNode({ id: "c", text: "Daily" }),
      createNode({ id: "d1", parentId: "deleted-week" }), // 2026-07-16
      createNode({ id: "d2", parentId: null }), // 2026-07-08, top-level stray
    ];
    const map = {
      c: "container",
      d1: "2026-07-16",
      d2: "2026-07-08",
    };
    const index = buildTreeIndex(nodes);
    expect(isOrphanMappedDay(index, nodes[1]!)).toBe(true);
    expect(isOrphanMappedDay(index, nodes[2]!)).toBe(true);
    const plan = planDailyMigration(index, "c", dayRows(map), keyOf(map));
    expect(plan.needed).toBe(true);
    expect(plan.days.map((d) => d.nodeId).sort()).toEqual(["d1", "d2"]);
    expect(plan.scaffoldKeys).toContain("week:2026-07-06");
    expect(plan.scaffoldKeys).toContain("week:2026-07-13");
  });

  test("day under the wrong week is needed (reattach), correct week is not", () => {
    const nodes = [
      createNode({ id: "c", text: "Daily" }),
      createNode({ id: "y", parentId: "c" }),
      createNode({ id: "m", parentId: "y" }),
      createNode({ id: "w29", parentId: "m" }),
      createNode({ id: "w28", parentId: "m" }),
      createNode({ id: "wrong", parentId: "w29" }), // belongs in week:2026-07-06
      createNode({ id: "right", parentId: "w29" }), // belongs in week:2026-07-13
    ];
    const map = {
      c: "container",
      y: "2026",
      m: "2026-07",
      w29: "week:2026-07-13",
      w28: "week:2026-07-06",
      wrong: "2026-07-08",
      right: "2026-07-16",
    };
    const plan = planDailyMigration(
      buildTreeIndex(nodes),
      "c",
      dayRows(map),
      keyOf(map),
    );
    expect(plan.needed).toBe(true);
    expect(plan.days.map((d) => d.nodeId).sort()).toEqual(["right", "wrong"]);
  });

  test("a day under a scaffold subtree relocated OUTSIDE Daily is left alone (finding 5)", () => {
    // The user dragged a whole year/week subtree (protection blocks delete/blank,
    // NOT move) out of the Daily container, under a plain note. The day still
    // maps to its week key AND its immediate parent is still a mapped scaffold
    // node -- so the old immediate-parent-only check would wrongly yank it back.
    // Full-ancestry scope (finding 5) leaves it alone: its chain never reaches
    // the container.
    const nodes = [
      createNode({ id: "c", text: "Daily" }),
      createNode({ id: "note", text: "Archive" }), // a normal top-level bullet
      createNode({ id: "y", parentId: "note" }), // year, relocated OUT of Daily
      createNode({ id: "w", parentId: "y" }), // week, under the relocated year
      createNode({ id: "moved", parentId: "w" }), // 2026-07-16, under the moved week
      createNode({ id: "flat", parentId: "c" }), // 2026-07-08, still flat -> triggers
    ];
    const map = {
      c: "container",
      y: "2026",
      w: "week:2026-07-13",
      moved: "2026-07-16",
      flat: "2026-07-08",
    };
    const plan = planDailyMigration(
      buildTreeIndex(nodes),
      "c",
      dayRows(map),
      keyOf(map),
    );
    expect(plan.needed).toBe(true); // the flat day still triggers it
    // Only the in-scaffold flat day migrates; the day under the relocated
    // subtree is out of scope because its ancestry never reaches the container.
    expect(plan.days.map((d) => d.nodeId)).toEqual(["flat"]);
  });
});
