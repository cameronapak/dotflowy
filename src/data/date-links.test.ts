import { describe, expect, test } from "bun:test";

import type { ScaffoldChain, ScaffoldKind, WeekStart } from "./date-links";

import {
  DATE_LINK_PATTERN,
  addDays,
  compareScaffoldKeys,
  dateSuggestions,
  dayKeyToScaffoldChain,
  dayKeyToWeekKey,
  flattenDateLinks,
  formatDateChipLabel,
  formatDateLabel,
  resolveWeekdayStem,
  weekdaySearchStems,
  isValidDateKey,
  localDateKey,
  monthKeyToCalendarGrid,
  monthKeyToYearKey,
  monthLabel,
  shiftMonthKey,
  parentScaffoldKey,
  parseDateLink,
  parseDateLinkKeys,
  scaffoldKeyKind,
  scaffoldLabel,
  type ScaffoldSibling,
  sortedInsertAfterId,
  shiftWeekKey,
  weekKeyToDayRange,
  weekKeyToDays,
  weekKeyToMonthKey,
  weekLabel,
  yearLabel,
} from "./date-links";
import { NODE_LINK_PATTERN } from "./node-links";

// Anchored, fresh regexes per assertion (the exported pattern is a fragment).
const matchesDate = (s: string) =>
  new RegExp(`^${DATE_LINK_PATTERN}$`, "u").test(s);
const matchesNodeLink = (s: string) =>
  new RegExp(`^${NODE_LINK_PATTERN}$`, "u").test(s);

describe("DATE_LINK_PATTERN", () => {
  test.each([
    ["[[2026-07-08]]", true],
    ["[[2026-07-08 14:00]]", true],
    // Near-misses stay literal (the node-links strictness discipline).
    ["[[July 8]]", false],
    ["[[2026-7-8]]", false], // un-padded month/day
    ["[[2026-07-08 9:00]]", false], // un-padded hour
    ["[[2026-07-08T14:00]]", false], // ISO T separator
    ["[[20260708]]", false],
    ["[[not a date]]", false],
  ])("%s -> %p", (input, expected) => {
    expect(matchesDate(input)).toBe(expected);
  });

  test("is disjoint from NODE_LINK_PATTERN in both directions", () => {
    // A date interior is never id-shaped...
    expect(matchesNodeLink("[[2026-07-08]]")).toBe(false);
    expect(matchesNodeLink("[[2026-07-08 14:00]]")).toBe(false);
    // ...and an id interior is never date-shaped.
    const uuid = "[[11111111-2222-3333-4444-555555555555]]";
    const fallback = "[[n_abc123_xyz789]]";
    expect(matchesNodeLink(uuid)).toBe(true);
    expect(matchesDate(uuid)).toBe(false);
    expect(matchesNodeLink(fallback)).toBe(true);
    expect(matchesDate(fallback)).toBe(false);
  });
});

test.each([
  ["[[2026-07-08]]", { key: "2026-07-08", time: null }],
  ["[[2026-07-08 14:30]]", { key: "2026-07-08", time: "14:30" }],
  ["[[2026-07-08 23:59]]", { key: "2026-07-08", time: "23:59" }],
  // Shape-matched but non-calendar interior.
  ["[[2026-13-45]]", null],
  ["[[2026-02-30]]", null],
  ["[[2026-00-10]]", null],
  // Non-clock time.
  ["[[2026-07-08 24:00]]", null],
  ["[[2026-07-08 14:60]]", null],
])("parseDateLink(%s)", (input, expected) => {
  expect(parseDateLink(input)).toEqual(expected);
});

test("parseDateLinkKeys extracts unique calendar keys in order", () => {
  expect(
    parseDateLinkKeys(
      "meet [[2026-04-22]] and [[2026-04-22 09:00]] then [[2026-05-01]]",
    ),
  ).toEqual(["2026-04-22", "2026-05-01"]);
  expect(parseDateLinkKeys("plain")).toEqual([]);
  expect(parseDateLinkKeys("see [[2026-13-45]]")).toEqual([]);
});

test("isValidDateKey / addDays / localDateKey work in local calendar days", () => {
  expect(isValidDateKey("2026-07-08")).toBe(true);
  expect(isValidDateKey("2026-02-29")).toBe(false); // 2026 is not a leap year
  expect(isValidDateKey("2024-02-29")).toBe(true);
  expect(isValidDateKey("garbage")).toBe(false);

  expect(addDays("2026-07-08", 1)).toBe("2026-07-09");
  expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
  expect(addDays("2026-01-01", -1)).toBe("2025-12-31");

  // LOCAL Y-M-D, zero-padded (never toISOString).
  expect(localDateKey(new Date(2026, 5, 23))).toBe("2026-06-23");
  expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  expect(localDateKey(new Date(2026, 5, 23, 23, 30))).toBe("2026-06-23");
});

test.each([
  ["2026-07-08", "Today"],
  ["2026-07-07", "Yesterday"],
  ["2026-07-09", "Tomorrow"],
  ["2026-01-15", "Jan 15"], // beyond +/-1: short date
])("formatDateLabel(%s) near 2026-07-08 -> %s", (key, expected) => {
  expect(formatDateLabel(key, "2026-07-08")).toBe(expected);
});

test.each([
  ["2026-07-08", "Today"],
  ["2026-07-09", "Tomorrow"],
  ["2026-07-07", "one day ago"],
  ["2026-07-06", "two days ago"],
  ["2026-07-02", "six days ago"],
  ["2026-07-10", "in two days"],
  ["2026-07-14", "in six days"],
  // Beyond +/-6: short absolute; another year includes the year.
  ["2026-07-01", "Jul 1"],
  ["2025-07-01", "Jul 1, 2025"],
])("formatDateChipLabel(%s) near 2026-07-08 -> %s", (key, expected) => {
  expect(formatDateChipLabel(key, "2026-07-08")).toBe(expected);
});

describe("resolveWeekdayStem / weekdaySearchStems", () => {
  const today = "2026-07-25"; // Saturday

  test("≥3-char stems resolve; next/last qualifiers", () => {
    expect(resolveWeekdayStem("thu", null, today)).toBe("2026-07-30");
    expect(resolveWeekdayStem("thursd", null, today)).toBe("2026-07-30");
    expect(resolveWeekdayStem("th", null, today)).toBeNull();
    expect(resolveWeekdayStem("fri", "last", today)).toBe("2026-07-24");
    expect(resolveWeekdayStem("friday", "next", today)).toBe("2026-07-31");
  });

  test("stems for Fuse aliases cover thu…thursday", () => {
    const stems = weekdaySearchStems("2026-07-30"); // Thursday
    expect(stems[0]).toBe("thu");
    expect(stems.at(-1)).toBe("thursday");
    expect(stems).toContain("thurs");
  });
});

describe("flattenDateLinks", () => {
  const today = "2026-07-08";

  test.each([
    ["due [[2026-07-08]] sharp", "due Today sharp"],
    ["standup [[2026-07-09 09:30]]", "standup Tomorrow 09:30"],
    ["was [[2026-07-07]]", "was one day ago"],
    // Near-misses and non-calendar tokens stay literal.
    ["see [[July 8]]", "see [[July 8]]"],
    ["see [[2026-13-45]]", "see [[2026-13-45]]"],
  ])("%s -> %s", (input, expected) => {
    expect(flattenDateLinks(input, today)).toBe(expected);
  });

  test("token-free text passes through untouched (same reference)", () => {
    const s = "no dates here";
    expect(flattenDateLinks(s, today)).toBe(s);
  });
});

test.each([
  ["tomo", [{ key: "2026-07-09", label: "Tomorrow" }]],
  ["yes", [{ key: "2026-07-07", label: "Yesterday" }]],
  // "to" prefixes both today and tomorrow; today ranks first.
  [
    "to",
    [
      { key: "2026-07-08", label: "Today" },
      { key: "2026-07-09", label: "Tomorrow" },
    ],
  ],
  // The relative words need at least two chars.
  ["t", []],
  ["y", []],
  // A fully typed valid ISO date.
  ["2026-12-25", [{ key: "2026-12-25", label: "Dec 25" }]],
  ["2026-13-45", []],
  ["", []],
  ["groceries", []],
])("dateSuggestions(%p) near 2026-07-08", (query, expected) => {
  expect(dateSuggestions(query, "2026-07-08")).toEqual(expected);
});

// --- Account Calendar weeks (ADR 0068) --------------------------------------
// Ground truth is hand-verified by day-of-week arithmetic (2026-10-11 and
// 2026-07-26 are Sundays; each result was cross-checked by calculation).

test.each<[string, WeekStart, string | null]>([
  // Monday and Sunday starts differ at the seam.
  ["2026-10-11", "monday", "week:2026-10-05"],
  ["2026-10-11", "sunday", "week:2026-10-11"],
  ["2026-10-12", "monday", "week:2026-10-12"],
  ["2026-10-12", "sunday", "week:2026-10-11"],
  ["2026-01-01", "monday", "week:2025-12-29"], // a week crosses the year
  ["2026-13-45", "sunday", null],
  ["garbage", "monday", null],
])("dayKeyToWeekKey(%s, %s) -> %p", (day, weekStart, week) => {
  expect(dayKeyToWeekKey(day, weekStart)).toBe(week);
});

test.each([
  // The fourth day owns the whole week in either mode: Jul 2 and Jul 1.
  ["week:2026-06-29", "2026-07"],
  ["week:2026-06-28", "2026-07"],
  ["week:2025-12-29", "2026-01"], // fourth day is 2026-01-01
  ["week:2026-13-45", null],
  // Legacy ISO keys remain readable as migration input.
  ["2026-W27", "2026-07"],
  ["2025-W53", null], // 2025 has 52 ISO weeks
  ["2026-W00", null],
  ["2026-07", null], // not a week key
])(
  "weekKeyToMonthKey(%s) -> %p (the fourth day owns the week)",
  (week, month) => {
    expect(weekKeyToMonthKey(week)).toBe(month);
  },
);

test.each([
  ["2026-07", "2026"],
  ["2026-13", null],
  ["2026-00", null],
  ["2026", null],
])("monthKeyToYearKey(%s) -> %p", (month, year) => {
  expect(monthKeyToYearKey(month)).toBe(year);
});

describe("shiftMonthKey / monthKeyToCalendarGrid (ADR 0055)", () => {
  test("shiftMonthKey pages months and years", () => {
    expect(shiftMonthKey("2026-07", 1)).toBe("2026-08");
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-13", 1)).toBeNull();
  });

  test("monthKeyToCalendarGrid pads out-of-month cells to the week start", () => {
    const grid = monthKeyToCalendarGrid("2026-08");
    expect(grid).not.toBeNull();
    expect(grid!.length % 7).toBe(0);
    expect(grid![0]).toEqual({ key: "2026-07-27", inMonth: false }); // Mon
    expect(grid!.find((c) => c.key === "2026-08-12")).toEqual({
      key: "2026-08-12",
      inMonth: true,
    });
    expect(grid!.at(-1)).toEqual({ key: "2026-09-06", inMonth: false }); // Sun

    // A Sunday start changes both grid boundaries.
    const sunday = monthKeyToCalendarGrid("2026-08", "sunday")!;
    expect(sunday[0]).toEqual({ key: "2026-07-26", inMonth: false });
    expect(sunday.at(-1)).toEqual({ key: "2026-09-05", inMonth: false });
  });
});

test.each<[string, ScaffoldKind | null]>([
  ["2026", "year"],
  ["2026-07", "month"],
  ["week:2026-07-13", "week"],
  ["2026-W29", "week"], // legacy migration input
  ["2026-07-16", "day"],
  ["container", "container"],
  ["2026-13-01", null], // bad day
  ["2026-13", null], // bad month
  ["week:2026-13-45", null], // bad week start
  ["2026-W99", null], // bad legacy week
  ["hello", null],
  ["", null],
])("scaffoldKeyKind(%p) -> %p", (key, kind) => {
  expect(scaffoldKeyKind(key)).toBe(kind);
});

describe("parentScaffoldKey (the Daily > Y > M > W > D climb)", () => {
  test("walks a straddle day all the way to its year", () => {
    // 2026-06-29 (June) -> its week -> July (fourth day Jul 2) -> 2026.
    const week = parentScaffoldKey("2026-06-29");
    expect(week).toBe("week:2026-06-29");
    const month = parentScaffoldKey(week!);
    expect(month).toBe("2026-07");
    const year = parentScaffoldKey(month!);
    expect(year).toBe("2026");
    expect(parentScaffoldKey(year!)).toBeNull();
  });

  test("container and unknown have no parent", () => {
    expect(parentScaffoldKey("container")).toBeNull();
    expect(parentScaffoldKey("nonsense")).toBeNull();
  });
});

test("compareScaffoldKeys orders pairs chronologically, weeks by start date", () => {
  expect(
    compareScaffoldKeys("week:2025-12-29", "week:2026-01-05"),
  ).toBeLessThan(0);
  expect(compareScaffoldKeys("week:2026-07-13", "week:2026-07-13")).toBe(0);
  expect(compareScaffoldKeys("2025", "2026")).toBeLessThan(0);
  expect(compareScaffoldKeys("2026-01", "2026-12")).toBeLessThan(0);
  expect(compareScaffoldKeys("2026-07-08", "2026-07-16")).toBeLessThan(0);
});

describe("display helpers", () => {
  test("year, month, week, and scaffold labels", () => {
    expect(yearLabel("2026")).toBe("2026");
    expect(monthLabel("2026-07")).toBe("July");
    expect(monthLabel("2026-01")).toBe("January");
    expect(monthLabel("2026-13")).toBe("2026-13"); // falls back to the key
    // A week is its date range, with years only across a year boundary.
    expect(weekLabel("week:2026-07-13")).toBe("Jul 13–19");
    expect(weekLabel("week:2026-08-30")).toBe("Aug 30–Sep 5");
    expect(weekLabel("week:2026-12-27")).toBe("Dec 27, 2026–Jan 2, 2027");
    expect(weekLabel("2026-W99")).toBe("2026-W99"); // nonexistent -> raw key
    // scaffoldLabel dispatches on kind; a day / container key is itself.
    expect(scaffoldLabel("2026")).toBe("2026");
    expect(scaffoldLabel("2026-07")).toBe("July");
    expect(scaffoldLabel("week:2026-07-13")).toBe("Jul 13–19");
    expect(scaffoldLabel("2026-07-16")).toBe("2026-07-16");
    expect(scaffoldLabel("container")).toBe("container");
  });

  test("weekKeyToDayRange gives the start and end day-keys", () => {
    expect(weekKeyToDayRange("week:2026-07-12")).toEqual({
      start: "2026-07-12",
      end: "2026-07-18",
    });
    // A legacy ISO key decodes to its Monday..Sunday.
    expect(weekKeyToDayRange("2026-W27")).toEqual({
      start: "2026-06-29",
      end: "2026-07-05",
    });
    expect(weekKeyToDayRange("2025-W53")).toBeNull();
  });
});

describe("weekKeyToDays / shiftWeekKey (ADR 0054 week strip)", () => {
  test("weekKeyToDays follows the key's start day, across a year boundary too", () => {
    expect(weekKeyToDays("week:2026-07-12")).toEqual([
      "2026-07-12",
      "2026-07-13",
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
      "2026-07-18",
    ]);
    // Every day round-trips to the SAME Sunday-start week.
    for (const day of weekKeyToDays("week:2026-07-12")!) {
      expect(dayKeyToWeekKey(day, "sunday")).toBe("week:2026-07-12");
    }
    expect(weekKeyToDays("week:2025-12-29")).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
    expect(weekKeyToDays("2025-W53")).toBeNull();
  });

  test.each([
    ["week:2026-07-13", 1, "week:2026-07-20"],
    ["week:2026-07-13", -1, "week:2026-07-06"],
    ["week:2026-07-13", 0, "week:2026-07-13"],
    ["week:2026-12-27", 1, "week:2027-01-03"],
    ["week:2026-12-27", -1, "week:2026-12-20"],
    ["nope", 1, null],
  ])("shiftWeekKey(%s, %d) -> %p", (week, delta, expected) => {
    expect(shiftWeekKey(week, delta)).toBe(expected);
  });
});

test.each<[string, WeekStart, ScaffoldChain | null]>([
  [
    "2026-07-16",
    "monday",
    { weekKey: "week:2026-07-13", monthKey: "2026-07", yearKey: "2026" },
  ],
  // A straddle day is owned WHOLE by its fourth day's month/year (Jul 2).
  [
    "2026-06-29",
    "monday",
    { weekKey: "week:2026-06-29", monthKey: "2026-07", yearKey: "2026" },
  ],
  // A Sunday start changes identity but keeps fourth-day ownership.
  [
    "2026-07-05",
    "sunday",
    { weekKey: "week:2026-07-05", monthKey: "2026-07", yearKey: "2026" },
  ],
  ["2026-13-45", "monday", null],
  ["garbage", "sunday", null],
])("dayKeyToScaffoldChain(%s, %s)", (day, weekStart, expected) => {
  expect(dayKeyToScaffoldChain(day, weekStart)).toEqual(expected);
});

const days = (...pairs: [string, string | null][]): ScaffoldSibling[] =>
  pairs.map(([id, key]) => ({ id, key }));

test.each([
  ["empty list -> head", days(), "2026-07-16", null],
  [
    "no same-kind sibling -> after the last bullet",
    days(["b1", null], ["b2", null]),
    "2026-07-16",
    "b2",
  ],
  [
    "smaller than every day, none leading -> head",
    days(["d2", "2026-07-08"], ["d3", "2026-07-16"]),
    "2026-07-01",
    null,
  ],
  [
    "smaller than every day, a bullet leads -> after the bullet",
    days(["bullet", null], ["d2", "2026-07-08"], ["d3", "2026-07-16"]),
    "2026-07-01",
    "bullet",
  ],
  [
    "middle -> after the greatest earlier day",
    days(["d1", "2026-07-01"], ["d2", "2026-07-08"], ["d3", "2026-07-20"]),
    "2026-07-16",
    "d2",
  ],
  // The Worker used to append past trailing bullets at the absolute tail; the
  // shared function chains after the last DAY, before the bullet (finding 9).
  [
    "new greatest -> after the last day, ahead of a trailing bullet",
    days(["d1", "2026-07-01"], ["d2", "2026-07-08"], ["bullet", null]),
    "2026-07-20",
    "d2",
  ],
  [
    "unsorted list -> after the greatest key below the new one",
    days(["d3", "2026-07-20"], ["d1", "2026-07-01"], ["d2", "2026-07-08"]),
    "2026-07-16",
    "d2",
  ],
  [
    "weeks order by their start date",
    days(["wA", "week:2025-12-22"], ["wB", "week:2026-01-05"]),
    "week:2025-12-29",
    "wA",
  ],
  [
    "only same-kind siblings count (a week among months appends)",
    days(["m1", "2026-01"], ["m2", "2026-07"]),
    "week:2026-07-13",
    "m2",
  ],
])("sortedInsertAfterId: %s", (_name, siblings, newKey, expected) => {
  expect(sortedInsertAfterId(siblings, newKey)).toBe(expected);
});
