import { describe, expect, test } from "bun:test";

import { dayKeyToWeekKey, scaffoldKeyKind } from "../../data/date-links";
import { buildTreeIndex, makeNode } from "../../data/tree";
import {
  formatWeekRange,
  formatWeekRelative,
  planDailyMigration,
  sortedInsertAfterId,
  type ScaffoldSibling,
} from "./scaffold";

describe("sortedInsertAfterId (chronological ascending, same-kind only)", () => {
  test("no children -> insert at start (null)", () => {
    expect(sortedInsertAfterId([], "2026-07-16")).toBeNull();
  });

  test("no same-kind sibling -> append at the end (keep bullets on top)", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "b1", key: null },
      { id: "b2", key: null },
    ];
    expect(sortedInsertAfterId(siblings, "2026-07-16")).toBe("b2");
  });

  test("smaller than every same-kind sibling, none leading -> head", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "d2", key: "2026-07-08" },
      { id: "d3", key: "2026-07-16" },
    ];
    expect(sortedInsertAfterId(siblings, "2026-07-01")).toBeNull();
  });

  test("smaller than every same-kind sibling, a bullet leads -> after the bullet", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "b", key: null },
      { id: "d2", key: "2026-07-08" },
      { id: "d3", key: "2026-07-16" },
    ];
    expect(sortedInsertAfterId(siblings, "2026-07-01")).toBe("b");
  });

  test("middle insert lands after the greatest earlier day", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "d1", key: "2026-07-01" },
      { id: "d2", key: "2026-07-08" },
      { id: "d3", key: "2026-07-20" },
    ];
    expect(sortedInsertAfterId(siblings, "2026-07-16")).toBe("d2");
  });

  test("larger than every same-kind sibling -> after the last day", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "d1", key: "2026-07-01" },
      { id: "d2", key: "2026-07-08" },
    ];
    expect(sortedInsertAfterId(siblings, "2026-07-20")).toBe("d2");
  });

  test("weeks order by ISO year then week number", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "wA", key: "2025-W52" },
      { id: "wB", key: "2026-W02" },
    ];
    // 2026-W01 sits between 2025-W52 and 2026-W02.
    expect(sortedInsertAfterId(siblings, "2026-W01")).toBe("wA");
  });

  test("only same-kind siblings count (a week among months appends)", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "m1", key: "2026-01" },
      { id: "m2", key: "2026-07" },
    ];
    expect(sortedInsertAfterId(siblings, "2026-W29")).toBe("m2");
  });
});

describe("formatWeekRange", () => {
  test("within one month -> 'Jul 13 – 19'", () => {
    expect(formatWeekRange("2026-W29")).toBe("Jul 13 – 19");
  });

  test("across a month boundary -> 'Dec 29 – Jan 4'", () => {
    expect(formatWeekRange("2026-W01")).toBe("Dec 29 – Jan 4");
  });

  test("nonexistent week -> the raw label", () => {
    expect(formatWeekRange("2025-W53")).toBe("2025-W53");
  });
});

describe("formatWeekRelative", () => {
  const today = "2026-07-16"; // ISO 2026-W29

  test("this week / last week, null beyond", () => {
    expect(formatWeekRelative("2026-W29", today)).toBe("This week");
    expect(formatWeekRelative("2026-W28", today)).toBe("Last week");
    expect(formatWeekRelative("2026-W27", today)).toBeNull();
    expect(formatWeekRelative("2026-W30", today)).toBeNull();
  });
});

describe("planDailyMigration", () => {
  /** Build a keyOf() over an explicit id -> key map. */
  const keyOf = (map: Record<string, string>) => (id: string) =>
    map[id] ?? null;

  test("flat days -> needed, ascending days, parents-first scaffold keys", () => {
    const nodes = [
      makeNode({ id: "c", text: "Daily" }),
      makeNode({ id: "d1", parentId: "c" }), // 2026-07-16
      makeNode({ id: "d2", parentId: "c" }), // 2026-07-08
      makeNode({ id: "d3", parentId: "c" }), // 2025-12-30 (ISO week-year 2026)
    ];
    const map = {
      c: "container",
      d1: "2026-07-16",
      d2: "2026-07-08",
      d3: "2025-12-30",
    };
    const plan = planDailyMigration(buildTreeIndex(nodes), "c", keyOf(map));

    expect(plan.needed).toBe(true);
    // Days ascending by date.
    expect(plan.days.map((d) => d.dayKey)).toEqual([
      "2025-12-30",
      "2026-07-08",
      "2026-07-16",
    ]);
    // Each day carries its owning week.
    for (const d of plan.days) {
      expect(d.weekKey).toBe(dayKeyToWeekKey(d.dayKey)!);
    }
    // Scaffold keys are parents-first: all years, then months, then weeks.
    const ranks = plan.scaffoldKeys.map(
      (k) => ({ year: 0, month: 1, week: 2 })[scaffoldKeyKind(k) as string],
    );
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
    }
    // The distinct expected keys (2025-12-30's Thursday is 2026-01-01, so it
    // rolls into ISO year 2026).
    const years = plan.scaffoldKeys.filter(
      (k) => scaffoldKeyKind(k) === "year",
    );
    const months = plan.scaffoldKeys.filter(
      (k) => scaffoldKeyKind(k) === "month",
    );
    expect(years).toEqual(["2026"]);
    expect(months).toEqual(["2026-01", "2026-07"]);
  });

  test("fully nested days -> not needed (idempotent re-entry)", () => {
    const nodes = [
      makeNode({ id: "c", text: "Daily" }),
      makeNode({ id: "y", parentId: "c" }),
      makeNode({ id: "w", parentId: "y" }),
      makeNode({ id: "d1", parentId: "w" }),
    ];
    const map = { c: "container", y: "2026", w: "2026-W29", d1: "2026-07-16" };
    const plan = planDailyMigration(buildTreeIndex(nodes), "c", keyOf(map));
    expect(plan.needed).toBe(false);
    // Still lists the day (a re-parent no-op) so a half-migrated tree heals.
    expect(plan.days.map((d) => d.dayKey)).toEqual(["2026-07-16"]);
  });

  test("brand-new empty account -> nothing to do", () => {
    const nodes = [makeNode({ id: "c", text: "Daily" })];
    const plan = planDailyMigration(
      buildTreeIndex(nodes),
      "c",
      keyOf({ c: "container" }),
    );
    expect(plan.needed).toBe(false);
    expect(plan.days).toEqual([]);
    expect(plan.scaffoldKeys).toEqual([]);
  });
});
