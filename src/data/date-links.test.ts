import { describe, expect, test } from "bun:test";

import {
  DATE_LINK_PATTERN,
  PROTECTED_SCAFFOLD_KINDS,
  addDays,
  compareScaffoldKeys,
  dateSuggestions,
  dayKeyToScaffoldChain,
  dayKeyToWeekKey,
  flattenDateLinks,
  formatDateLabel,
  isValidDateKey,
  localDateKey,
  monthKeyToYearKey,
  monthLabel,
  parentScaffoldKey,
  parseDateLink,
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
  test("matches a bare date and a date + 24h time", () => {
    expect(matchesDate("[[2026-07-08]]")).toBe(true);
    expect(matchesDate("[[2026-07-08 14:00]]")).toBe(true);
  });

  test("near-misses stay literal (the node-links strictness discipline)", () => {
    expect(matchesDate("[[July 8]]")).toBe(false);
    expect(matchesDate("[[2026-7-8]]")).toBe(false); // un-padded month/day
    expect(matchesDate("[[2026-07-08 9:00]]")).toBe(false); // un-padded hour
    expect(matchesDate("[[2026-07-08T14:00]]")).toBe(false); // ISO T separator
    expect(matchesDate("[[20260708]]")).toBe(false);
    expect(matchesDate("[[not a date]]")).toBe(false);
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

describe("parseDateLink", () => {
  test("extracts the key (first 10 interior chars) and optional time", () => {
    expect(parseDateLink("[[2026-07-08]]")).toEqual({
      key: "2026-07-08",
      time: null,
    });
    expect(parseDateLink("[[2026-07-08 14:30]]")).toEqual({
      key: "2026-07-08",
      time: "14:30",
    });
  });

  test("rejects a shape-matched but non-calendar interior", () => {
    expect(parseDateLink("[[2026-13-45]]")).toBeNull();
    expect(parseDateLink("[[2026-02-30]]")).toBeNull();
    expect(parseDateLink("[[2026-00-10]]")).toBeNull();
  });

  test("rejects a non-clock time", () => {
    expect(parseDateLink("[[2026-07-08 24:00]]")).toBeNull();
    expect(parseDateLink("[[2026-07-08 14:60]]")).toBeNull();
    expect(parseDateLink("[[2026-07-08 23:59]]")).toEqual({
      key: "2026-07-08",
      time: "23:59",
    });
  });
});

describe("isValidDateKey / addDays / localDateKey", () => {
  test("validates real local calendar days only", () => {
    expect(isValidDateKey("2026-07-08")).toBe(true);
    expect(isValidDateKey("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isValidDateKey("2024-02-29")).toBe(true);
    expect(isValidDateKey("garbage")).toBe(false);
  });

  test("addDays crosses month/year boundaries in local time", () => {
    expect(addDays("2026-07-08", 1)).toBe("2026-07-09");
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  test("localDateKey formats LOCAL Y-M-D, zero-padded (never toISOString)", () => {
    expect(localDateKey(new Date(2026, 5, 23))).toBe("2026-06-23");
    expect(localDateKey(new Date(2026, 5, 23, 23, 30))).toBe("2026-06-23");
  });
});

describe("formatDateLabel", () => {
  const today = "2026-07-08";

  test("speaks the badge language near today", () => {
    expect(formatDateLabel("2026-07-08", today)).toBe("Today");
    expect(formatDateLabel("2026-07-07", today)).toBe("Yesterday");
    expect(formatDateLabel("2026-07-09", today)).toBe("Tomorrow");
  });

  test("falls back to a short date beyond +/-1", () => {
    const label = formatDateLabel("2026-01-15", today);
    expect(label).not.toBe("Today");
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("flattenDateLinks", () => {
  const today = "2026-07-08";

  test("replaces tokens with their display label, time after the label", () => {
    expect(flattenDateLinks("due [[2026-07-08]] sharp", today)).toBe(
      "due Today sharp",
    );
    expect(flattenDateLinks("standup [[2026-07-09 09:30]]", today)).toBe(
      "standup Tomorrow 09:30",
    );
  });

  test("leaves near-misses and non-calendar tokens literal", () => {
    expect(flattenDateLinks("see [[July 8]]", today)).toBe("see [[July 8]]");
    expect(flattenDateLinks("see [[2026-13-45]]", today)).toBe(
      "see [[2026-13-45]]",
    );
  });

  test("token-free text passes through untouched (same reference)", () => {
    const s = "no dates here";
    expect(flattenDateLinks(s, today)).toBe(s);
  });
});

describe("dateSuggestions", () => {
  const today = "2026-07-08";

  test("offers today/tomorrow/yesterday on a word-prefix match", () => {
    expect(dateSuggestions("tomo", today)).toEqual([
      { key: "2026-07-09", label: "Tomorrow" },
    ]);
    expect(dateSuggestions("yes", today)).toEqual([
      { key: "2026-07-07", label: "Yesterday" },
    ]);
    // "to" prefixes both today and tomorrow; today ranks first.
    expect(dateSuggestions("to", today)).toEqual([
      { key: "2026-07-08", label: "Today" },
      { key: "2026-07-09", label: "Tomorrow" },
    ]);
  });

  test("needs at least two chars for the relative words", () => {
    expect(dateSuggestions("t", today)).toEqual([]);
    expect(dateSuggestions("y", today)).toEqual([]);
  });

  test("offers a fully typed valid ISO date", () => {
    expect(dateSuggestions("2026-12-25", today)).toEqual([
      { key: "2026-12-25", label: formatDateLabel("2026-12-25", today) },
    ]);
    expect(dateSuggestions("2026-13-45", today)).toEqual([]);
  });

  test("empty or non-date-ish queries return nothing", () => {
    expect(dateSuggestions("", today)).toEqual([]);
    expect(dateSuggestions("groceries", today)).toEqual([]);
  });
});

// --- Daily calendar scaffold (issue #271) -----------------------------------
// Ground truth is hand-verified by day-of-week arithmetic (Jan 1 2026 is a
// Thursday; 2026 has 365 days; each result was cross-checked by calculation).

describe("dayKeyToWeekKey (ISO 8601, Thursday-decides)", () => {
  test("Jan 1 2026 is a Thursday -> its own W01", () => {
    expect(dayKeyToWeekKey("2026-01-01")).toBe("2026-W01");
  });

  test("a late-Dec Monday joins the NEXT year's W01 (crosses the year)", () => {
    // 2025-12-29 is a Monday whose week's Thursday is 2026-01-01.
    expect(dayKeyToWeekKey("2025-12-29")).toBe("2026-W01");
  });

  test("a late-Dec Sunday stays in the OLD year's last week (W52)", () => {
    // 2025-12-28 is a Sunday whose week's Thursday is 2025-12-25.
    expect(dayKeyToWeekKey("2025-12-28")).toBe("2025-W52");
  });

  test("2026 is a 53-week ISO year (Dec 31 2026 is a Thursday -> W53)", () => {
    expect(dayKeyToWeekKey("2026-12-31")).toBe("2026-W53");
  });

  test("the issue's straddle week (Jun 29 - Jul 5 2026) is W27", () => {
    expect(dayKeyToWeekKey("2026-06-29")).toBe("2026-W27"); // Monday
    expect(dayKeyToWeekKey("2026-07-05")).toBe("2026-W27"); // Sunday, same week
  });

  test("null on a malformed / non-calendar day key", () => {
    expect(dayKeyToWeekKey("2026-13-45")).toBeNull();
    expect(dayKeyToWeekKey("garbage")).toBeNull();
  });
});

describe("weekKeyToMonthKey (the Thursday rule owns the straddle)", () => {
  test("the Jun-29..Jul-5 straddle week is owned WHOLE by July", () => {
    // Thursday 2026-07-02 -> July, even though 3 of its days are in June.
    expect(weekKeyToMonthKey("2026-W27")).toBe("2026-07");
  });

  test("a year-crossing week is owned by the Thursday's month/year", () => {
    expect(weekKeyToMonthKey("2026-W01")).toBe("2026-01"); // Thu 2026-01-01
    expect(weekKeyToMonthKey("2025-W52")).toBe("2025-12"); // Thu 2025-12-25
  });

  test("null on a nonexistent week (W53 in a 52-week year rolls out)", () => {
    expect(weekKeyToMonthKey("2025-W53")).toBeNull(); // 2025 has 52 ISO weeks
    expect(weekKeyToMonthKey("2026-W00")).toBeNull();
    expect(weekKeyToMonthKey("2026-07")).toBeNull(); // not a week key
  });
});

describe("monthKeyToYearKey", () => {
  test("strips to the year", () => {
    expect(monthKeyToYearKey("2026-07")).toBe("2026");
  });

  test("null on malformed / out-of-range", () => {
    expect(monthKeyToYearKey("2026-13")).toBeNull();
    expect(monthKeyToYearKey("2026-00")).toBeNull();
    expect(monthKeyToYearKey("2026")).toBeNull();
  });
});

describe("scaffoldKeyKind", () => {
  test("classifies each valid shape", () => {
    expect(scaffoldKeyKind("2026")).toBe("year");
    expect(scaffoldKeyKind("2026-07")).toBe("month");
    expect(scaffoldKeyKind("2026-W29")).toBe("week");
    expect(scaffoldKeyKind("2026-07-16")).toBe("day");
    expect(scaffoldKeyKind("container")).toBe("container");
  });

  test("null for shape-shaped-but-invalid and unknown strings", () => {
    expect(scaffoldKeyKind("2026-13-01")).toBeNull(); // bad day
    expect(scaffoldKeyKind("2026-13")).toBeNull(); // bad month
    expect(scaffoldKeyKind("2026-W99")).toBeNull(); // bad week
    expect(scaffoldKeyKind("hello")).toBeNull();
    expect(scaffoldKeyKind("")).toBeNull();
  });
});

describe("parentScaffoldKey (the Daily > Y > M > W > D climb)", () => {
  test("walks a straddle day all the way to its year", () => {
    // 2026-06-29 (June) -> W27 -> July (Thursday rule) -> 2026.
    const week = parentScaffoldKey("2026-06-29");
    expect(week).toBe("2026-W27");
    const month = parentScaffoldKey(week!);
    expect(month).toBe("2026-07");
    const year = parentScaffoldKey(month!);
    expect(year).toBe("2026");
    expect(parentScaffoldKey(year!)).toBeNull();
  });

  test("year is the top; container and unknown have no parent", () => {
    expect(parentScaffoldKey("2026")).toBeNull();
    expect(parentScaffoldKey("container")).toBeNull();
    expect(parentScaffoldKey("nonsense")).toBeNull();
  });
});

describe("compareScaffoldKeys (chronological ascending)", () => {
  test("weeks order across a year boundary (2025-W52 < 2026-W01)", () => {
    expect(compareScaffoldKeys("2025-W52", "2026-W01")).toBeLessThan(0);
    expect(compareScaffoldKeys("2026-W01", "2025-W52")).toBeGreaterThan(0);
  });

  test("weeks order within a year by number, not by string", () => {
    expect(compareScaffoldKeys("2026-W02", "2026-W29")).toBeLessThan(0);
    expect(compareScaffoldKeys("2026-W29", "2026-W29")).toBe(0);
  });

  test("years, months, and days order chronologically", () => {
    expect(compareScaffoldKeys("2025", "2026")).toBeLessThan(0);
    expect(compareScaffoldKeys("2026-01", "2026-12")).toBeLessThan(0);
    expect(compareScaffoldKeys("2026-07-08", "2026-07-16")).toBeLessThan(0);
  });

  test("a real sibling list sorts ascending", () => {
    const weeks = ["2026-W29", "2025-W52", "2026-W01", "2026-W02"];
    expect([...weeks].sort(compareScaffoldKeys)).toEqual([
      "2025-W52",
      "2026-W01",
      "2026-W02",
      "2026-W29",
    ]);
  });
});

describe("display helpers", () => {
  test("yearLabel is the key", () => {
    expect(yearLabel("2026")).toBe("2026");
  });

  test("monthLabel is the en-US month name", () => {
    expect(monthLabel("2026-07")).toBe("July");
    expect(monthLabel("2026-01")).toBe("January");
    expect(monthLabel("2026-13")).toBe("2026-13"); // falls back to the key
  });

  test("weekLabel is 'Week N' with no leading zero", () => {
    expect(weekLabel("2026-W29")).toBe("Week 29");
    expect(weekLabel("2026-W01")).toBe("Week 1");
    expect(weekLabel("2026-W99")).toBe("2026-W99"); // nonexistent -> raw key
  });

  test("weekKeyToDayRange gives the Monday and Sunday day-keys", () => {
    // 2026-W29 has Thursday 2026-07-16 -> Mon 2026-07-13, Sun 2026-07-19.
    expect(weekKeyToDayRange("2026-W29")).toEqual({
      monday: "2026-07-13",
      sunday: "2026-07-19",
    });
    // A year-crossing week's range spans the boundary.
    expect(weekKeyToDayRange("2026-W01")).toEqual({
      monday: "2025-12-29",
      sunday: "2026-01-04",
    });
    expect(weekKeyToDayRange("2025-W53")).toBeNull();
  });
});

describe("weekKeyToDays / shiftWeekKey (ADR 0054 week strip)", () => {
  test("weekKeyToDays lists Monday..Sunday in order", () => {
    expect(weekKeyToDays("2026-W29")).toEqual([
      "2026-07-13",
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
    ]);
    // Every day round-trips to the SAME week (no straddle).
    for (const day of weekKeyToDays("2026-W29")!) {
      expect(dayKeyToWeekKey(day)).toBe("2026-W29");
    }
  });

  test("weekKeyToDays spans a year boundary intact", () => {
    expect(weekKeyToDays("2026-W01")).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });

  test("weekKeyToDays is null on a nonexistent week", () => {
    expect(weekKeyToDays("2025-W53")).toBeNull();
  });

  test("shiftWeekKey pages forward and back by whole weeks", () => {
    expect(shiftWeekKey("2026-W29", 1)).toBe("2026-W30");
    expect(shiftWeekKey("2026-W29", -1)).toBe("2026-W28");
    expect(shiftWeekKey("2026-W29", 0)).toBe("2026-W29");
  });

  test("shiftWeekKey crosses a year boundary correctly", () => {
    // 2026-W01 back one week is the last week of 2025 (a 53-week ISO year).
    expect(shiftWeekKey("2026-W01", -1)).toBe("2025-W52");
    // Forward from the last full week of December 2026 into 2027's W01.
    expect(shiftWeekKey("2026-W53", 1)).toBe("2027-W01");
  });

  test("shiftWeekKey is null on a malformed week", () => {
    expect(shiftWeekKey("nope", 1)).toBeNull();
  });
});

describe("dayKeyToScaffoldChain (the one Thursday-rule waterfall)", () => {
  test("walks day -> week -> month -> year", () => {
    expect(dayKeyToScaffoldChain("2026-07-16")).toEqual({
      weekKey: "2026-W29",
      monthKey: "2026-07",
      yearKey: "2026",
    });
  });

  test("a straddle day is owned WHOLE by its Thursday's month/year", () => {
    // 2026-06-29 (June) -> W27 whose Thursday (Jul 2) is July 2026.
    expect(dayKeyToScaffoldChain("2026-06-29")).toEqual({
      weekKey: "2026-W27",
      monthKey: "2026-07",
      yearKey: "2026",
    });
  });

  test("null on a malformed / non-calendar day key", () => {
    expect(dayKeyToScaffoldChain("2026-13-45")).toBeNull();
    expect(dayKeyToScaffoldChain("garbage")).toBeNull();
  });
});

describe("scaffoldLabel + PROTECTED_SCAFFOLD_KINDS", () => {
  test("scaffoldLabel dispatches on kind, raw key otherwise", () => {
    expect(scaffoldLabel("2026")).toBe("2026");
    expect(scaffoldLabel("2026-07")).toBe("July");
    expect(scaffoldLabel("2026-W29")).toBe("Week 29");
    // A day / container / unknown key falls through to itself (text owned else).
    expect(scaffoldLabel("2026-07-16")).toBe("2026-07-16");
    expect(scaffoldLabel("container")).toBe("container");
  });

  test("PROTECTED_SCAFFOLD_KINDS is container + Y/M/W, never day", () => {
    expect(PROTECTED_SCAFFOLD_KINDS.has("container")).toBe(true);
    expect(PROTECTED_SCAFFOLD_KINDS.has("year")).toBe(true);
    expect(PROTECTED_SCAFFOLD_KINDS.has("month")).toBe(true);
    expect(PROTECTED_SCAFFOLD_KINDS.has("week")).toBe(true);
    expect(PROTECTED_SCAFFOLD_KINDS.has("day")).toBe(false);
  });
});

describe("sortedInsertAfterId (shared placement, client + Worker)", () => {
  test("empty list -> head (null)", () => {
    expect(sortedInsertAfterId([], "2026-07-16")).toBeNull();
  });

  test("middle insert lands after the greatest earlier same-kind sibling", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "d1", key: "2026-07-01" },
      { id: "d2", key: "2026-07-08" },
      { id: "d3", key: "2026-07-20" },
    ];
    expect(sortedInsertAfterId(siblings, "2026-07-16")).toBe("d2");
  });

  test("a new greatest key lands AHEAD of a trailing non-scaffold sibling", () => {
    // The Worker used to append past trailing bullets at the absolute tail; the
    // shared function chains after the last DAY, before the bullet (finding 9).
    const siblings: ScaffoldSibling[] = [
      { id: "d1", key: "2026-07-01" },
      { id: "d2", key: "2026-07-08" },
      { id: "bullet", key: null },
    ];
    expect(sortedInsertAfterId(siblings, "2026-07-20")).toBe("d2");
  });

  test("robust to an UNSORTED same-kind list (best-effort during migration)", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "d3", key: "2026-07-20" },
      { id: "d1", key: "2026-07-01" },
      { id: "d2", key: "2026-07-08" },
    ];
    // Predecessor is the greatest key strictly < newKey, wherever it sits.
    expect(sortedInsertAfterId(siblings, "2026-07-16")).toBe("d2");
  });

  test("smaller than every same-kind sibling, a bullet leads -> after the bullet", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "bullet", key: null },
      { id: "d2", key: "2026-07-08" },
      { id: "d3", key: "2026-07-16" },
    ];
    expect(sortedInsertAfterId(siblings, "2026-07-01")).toBe("bullet");
  });

  test("only same-kind siblings count (a week among months appends)", () => {
    const siblings: ScaffoldSibling[] = [
      { id: "m1", key: "2026-01" },
      { id: "m2", key: "2026-07" },
    ];
    expect(sortedInsertAfterId(siblings, "2026-W29")).toBe("m2");
  });
});
