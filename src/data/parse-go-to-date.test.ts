import { describe, expect, test } from "bun:test";

import type { PeriodQualifier, PeriodUnit } from "./date-links";

import {
  goToDateLabel,
  parseDatePickerQuery,
  parseDatePickerTargets,
  parseGoToDateQuery,
  parseGoToDateTargets,
  periodCatalogUnits,
  pickerDateLabel,
  pickerDateSuggestions,
} from "./parse-go-to-date";

/** Fixed noon local Saturday 2026-07-25 (Monday-start week Jul 20 to Jul 26,
 *  Sunday-start week Jul 19 to Jul 25), so weekdays and relatives stay stable. */
const NOW = new Date(2026, 6, 25, 12);

describe("parseGoToDateQuery", () => {
  test("ISO fast-path", () => {
    expect(parseGoToDateQuery("2026-08-12", NOW)).toEqual({
      key: "2026-08-12",
      kind: "day",
      label: "Go to Wednesday, August 12, 2026",
    });
  });

  test.each([
    // Prose absolute dates.
    ["August 12th", "2026-08-12"],
    ["Aug 12", "2026-08-12"],
    ["August 12 2026", "2026-08-12"],
    // Relatives, with prefixes.
    ["today", "2026-07-25"],
    ["to", "2026-07-25"],
    ["tomorrow", "2026-07-26"],
    ["tom", "2026-07-26"],
    ["yesterday", "2026-07-24"],
    ["next Monday", "2026-07-27"],
    ["in 2 weeks", "2026-08-08"],
    ["last Friday", "2026-07-24"],
    // Owned weekday stems fill chrono gaps (upcoming Thursday is Jul 30).
    ["thurs", "2026-07-30"],
    ["thursd", "2026-07-30"],
    ["thursda", "2026-07-30"],
    ["mond", "2026-07-27"],
    ["next thurs", "2026-07-30"],
    ["last fri", "2026-07-24"],
    // A bare weekday prefers the upcoming day (forwardDate).
    ["Friday", "2026-07-31"],
  ])("%p -> %s", (query, key) => {
    expect(parseGoToDateQuery(query, NOW)?.key).toBe(key);
  });

  test("period phrases navigate the Calendar scaffold, not chrono's mid-week day", () => {
    expect(parseGoToDateQuery("next week", NOW)).toEqual({
      key: "week:2026-07-27",
      kind: "week",
      label: "Go to Next week",
    });
    expect(parseGoToDateQuery("last week", NOW)?.key).toBe("week:2026-07-13");
    // The configured week start decides which week is next.
    expect(parseGoToDateQuery("next week", NOW, "sunday")?.key).toBe(
      "week:2026-07-26",
    );
    expect(parseGoToDateQuery("last month", NOW)).toEqual({
      key: "2026-06",
      kind: "month",
      label: "Go to Last month",
    });
    expect(parseGoToDateQuery("next year", NOW)?.key).toBe("2027");
  });

  test.each([
    "2026-13-45", // invalid ISO calendar day
    "project alpha",
    "a",
    "",
    "meet on August 12th please", // a date buried in longer prose
  ])("rejects %p", (query) => {
    expect(parseGoToDateQuery(query, NOW)).toBeNull();
  });
});

test.each<[string, { qualifier: PeriodQualifier; units: PeriodUnit[] } | null]>(
  [
    // Requires the full word next/last: a bare "ne" stays quiet.
    ["ne", null],
    ["la", null],
    ["nex", null],
    ["next", { qualifier: "next", units: ["week", "month", "year"] }],
    ["next ", { qualifier: "next", units: ["week", "month", "year"] }],
    ["last", { qualifier: "last", units: ["week", "month", "year"] }],
    // A typed suffix filters the trio.
    ["next w", { qualifier: "next", units: ["week"] }],
    ["next we", { qualifier: "next", units: ["week"] }],
    ["last m", { qualifier: "last", units: ["month"] }],
    ["next y", { qualifier: "next", units: ["year"] }],
    ["next friday", null],
  ],
)("periodCatalogUnits(%p) -> %p", (query, expected) => {
  const got = periodCatalogUnits(query);
  expect(got && { qualifier: got.qualifier, units: got.units }).toEqual(
    expected,
  );
});

test("Cmd+K catalog returns the three scaffold hits", () => {
  expect(parseGoToDateTargets("next", NOW)).toEqual([
    { key: "week:2026-07-27", kind: "week", label: "Go to Next week" },
    { key: "2026-08", kind: "month", label: "Go to Next month" },
    { key: "2027", kind: "year", label: "Go to Next year" },
  ]);
});

test("[[ catalog returns period-start day keys (week start, the 1st, Jan 1)", () => {
  expect(parseDatePickerTargets("next", NOW)).toEqual([
    { key: "2026-07-27", label: "Next week" },
    { key: "2026-08-01", label: "Next month" },
    { key: "2027-01-01", label: "Next year" },
  ]);
  expect(parseDatePickerTargets("last w", NOW)).toEqual([
    { key: "2026-07-13", label: "Last week" },
  ]);
  expect(parseDatePickerTargets("next w", NOW, "sunday")).toEqual([
    { key: "2026-07-26", label: "Next week" },
  ]);
});

test("pickerDateLabel and goToDateLabel are short near today, full otherwise", () => {
  const today = "2026-07-25";
  expect(pickerDateLabel("2026-07-25", today)).toBe("Today");
  expect(pickerDateLabel("2026-07-26", today)).toBe("Tomorrow");
  expect(pickerDateLabel("2026-07-24", today)).toBe("Yesterday");
  expect(pickerDateLabel("2026-01-29", today)).toBe(
    "Thursday, January 29, 2026",
  );
  expect(goToDateLabel("2026-07-25", today)).toBe("Go to Today");
  expect(goToDateLabel("2026-07-26", today)).toBe("Go to Tomorrow");
  expect(goToDateLabel("2026-07-24", today)).toBe("Go to Yesterday");
  expect(goToDateLabel("2026-08-12", today)).toBe(
    "Go to Wednesday, August 12, 2026",
  );
});

describe("parseDatePickerQuery (stricter [[ picker gate)", () => {
  test("ISO and relatives still work", () => {
    expect(parseDatePickerQuery("2026-08-12", NOW)).toEqual({
      key: "2026-08-12",
      label: "Wednesday, August 12, 2026",
    });
    expect(parseDatePickerQuery("tomorrow", NOW)).toEqual({
      key: "2026-07-26",
      label: "Tomorrow",
    });
    expect(parseDatePickerQuery("tomo", NOW)?.key).toBe("2026-07-26");
  });

  test.each([
    // Calendar-complete chrono (day-of-month or year) is accepted.
    ["April 22 2026", "2026-04-22"],
    ["Aug 12", "2026-08-12"],
    ["April 2026", "2026-04-01"],
    // Weekday phrases are allowed.
    ["Monday", "2026-07-27"],
    ["Friday", "2026-07-31"],
    ["next Monday", "2026-07-27"],
    ["Thursday", "2026-07-30"],
    ["thursd", "2026-07-30"],
    // A period resolves to its period-start day, not the scaffold key.
    ["next week", "2026-07-27"],
    ["next month", "2026-08-01"],
    // A bare month is still blocked.
    ["April", undefined],
  ])("%p -> %p", (query, key) => {
    expect(parseDatePickerQuery(query, NOW)?.key).toBe(key);
  });
});

test.each([
  // Merges relatives with gated NL and dedupes by key.
  ["tomo", [{ key: "2026-07-26", label: "Tomorrow" }]],
  [
    "April 22 2026",
    [{ key: "2026-04-22", label: "Wednesday, April 22, 2026" }],
  ],
  ["2026-01-29", [{ key: "2026-01-29", label: "Thursday, January 29, 2026" }]],
  ["April", []],
  // The catalog trio surfaces Next week/month/year.
  [
    "next",
    [
      { key: "2026-07-27", label: "Next week" },
      { key: "2026-08-01", label: "Next month" },
      { key: "2027-01-01", label: "Next year" },
    ],
  ],
])("pickerDateSuggestions(%p)", (query, expected) => {
  expect(pickerDateSuggestions(query, NOW)).toEqual(expected);
});
