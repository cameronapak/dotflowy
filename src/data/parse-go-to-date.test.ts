import { describe, expect, test } from "bun:test";

import {
  dayKeyToWeekKey,
  formatDateFull,
  resolvePeriod,
  shiftMonthKey,
} from "./date-links";
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

/** Fixed noon local Saturday 2026-07-25 — weekdays/relatives stay stable. */
const NOW = new Date(2026, 6, 25, 12);
const TODAY = "2026-07-25";

describe("parseGoToDateQuery", () => {
  test("ISO fast-path", () => {
    const hit = parseGoToDateQuery("2026-08-12", NOW);
    expect(hit?.key).toBe("2026-08-12");
    expect(hit?.kind).toBe("day");
    expect(hit?.label).toMatch(/^Go to /);
    expect(hit?.label).toContain("2026");
    expect(hit?.label).toContain("12");
  });

  test("rejects invalid ISO calendar days", () => {
    expect(parseGoToDateQuery("2026-13-45", NOW)).toBeNull();
  });

  test("prose absolute dates", () => {
    expect(parseGoToDateQuery("August 12th", NOW)?.key).toBe("2026-08-12");
    expect(parseGoToDateQuery("Aug 12", NOW)?.key).toBe("2026-08-12");
    expect(parseGoToDateQuery("August 12 2026", NOW)?.key).toBe("2026-08-12");
  });

  test("relatives and weekdays", () => {
    expect(parseGoToDateQuery("today", NOW)?.key).toBe("2026-07-25");
    expect(parseGoToDateQuery("to", NOW)?.key).toBe("2026-07-25"); // prefix
    expect(parseGoToDateQuery("tomorrow", NOW)?.key).toBe("2026-07-26");
    expect(parseGoToDateQuery("tom", NOW)?.key).toBe("2026-07-26");
    expect(parseGoToDateQuery("yesterday", NOW)?.key).toBe("2026-07-24");
    expect(parseGoToDateQuery("next Monday", NOW)?.key).toBe("2026-07-27");
    expect(parseGoToDateQuery("in 2 weeks", NOW)?.key).toBe("2026-08-08");
    expect(parseGoToDateQuery("last Friday", NOW)?.key).toBe("2026-07-24");
  });

  test("owned weekday stems fill chrono gaps", () => {
    // Sat Jul 25 → upcoming Thursday = Jul 30
    expect(parseGoToDateQuery("thurs", NOW)?.key).toBe("2026-07-30");
    expect(parseGoToDateQuery("thursd", NOW)?.key).toBe("2026-07-30");
    expect(parseGoToDateQuery("thursda", NOW)?.key).toBe("2026-07-30");
    expect(parseGoToDateQuery("mond", NOW)?.key).toBe("2026-07-27");
    expect(parseGoToDateQuery("next thurs", NOW)?.key).toBe("2026-07-30");
    expect(parseGoToDateQuery("last fri", NOW)?.key).toBe("2026-07-24");
  });

  test("bare weekday prefers the upcoming day (forwardDate)", () => {
    // Sat Jul 25 → next Friday is Jul 31
    expect(parseGoToDateQuery("Friday", NOW)?.key).toBe("2026-07-31");
  });

  test("period phrases navigate ISO scaffold (not chrono mid-week day)", () => {
    const nextWeek = resolvePeriod("next", "week", TODAY)!;
    const hit = parseGoToDateQuery("next week", NOW);
    expect(hit?.kind).toBe("week");
    expect(hit?.key).toBe(nextWeek.scaffoldKey);
    expect(hit?.label).toBe("Go to Next week");

    const lastMonth = resolvePeriod("last", "month", TODAY)!;
    expect(parseGoToDateQuery("last month", NOW)).toEqual({
      key: lastMonth.scaffoldKey,
      kind: "month",
      label: "Go to Last month",
    });

    const nextYear = resolvePeriod("next", "year", TODAY)!;
    expect(parseGoToDateQuery("next year", NOW)?.key).toBe(
      nextYear.scaffoldKey,
    );
  });

  test("rejects non-date prose and short junk", () => {
    expect(parseGoToDateQuery("project alpha", NOW)).toBeNull();
    expect(parseGoToDateQuery("a", NOW)).toBeNull();
    expect(parseGoToDateQuery("", NOW)).toBeNull();
  });

  test("rejects a date buried in longer prose", () => {
    expect(parseGoToDateQuery("meet on August 12th please", NOW)).toBeNull();
  });
});

describe("periodCatalogUnits / catalog trio", () => {
  test("requires full word next/last — bare ne is quiet", () => {
    expect(periodCatalogUnits("ne")).toBeNull();
    expect(periodCatalogUnits("la")).toBeNull();
    expect(periodCatalogUnits("nex")).toBeNull();
  });

  test("next / next  / last open the full trio", () => {
    expect(periodCatalogUnits("next")?.units).toEqual([
      "week",
      "month",
      "year",
    ]);
    expect(periodCatalogUnits("next ")?.units).toEqual([
      "week",
      "month",
      "year",
    ]);
    expect(periodCatalogUnits("last")?.qualifier).toBe("last");
  });

  test("typed suffix filters the trio", () => {
    expect(periodCatalogUnits("next w")?.units).toEqual(["week"]);
    expect(periodCatalogUnits("next we")?.units).toEqual(["week"]);
    expect(periodCatalogUnits("last m")?.units).toEqual(["month"]);
    expect(periodCatalogUnits("next y")?.units).toEqual(["year"]);
    expect(periodCatalogUnits("next friday")).toBeNull();
  });

  test("Cmd+K catalog returns up to three scaffold hits", () => {
    const hits = parseGoToDateTargets("next", NOW);
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.kind)).toEqual(["week", "month", "year"]);
    expect(hits.every((h) => h.label.startsWith("Go to Next "))).toBe(true);
  });

  test("[[ catalog returns period-start day keys with labels", () => {
    const hits = parseDatePickerTargets("next", NOW);
    expect(hits).toHaveLength(3);
    const week = resolvePeriod("next", "week", TODAY)!;
    const month = resolvePeriod("next", "month", TODAY)!;
    const year = resolvePeriod("next", "year", TODAY)!;
    expect(hits[0]).toEqual({
      key: week.periodStartDay,
      label: "Next week",
    });
    expect(hits[1]?.key).toBe(month.periodStartDay);
    expect(hits[2]?.key).toBe(year.periodStartDay);
    // Period-start is Monday / 1st / Jan 1 — not chrono's mid-week day.
    expect(hits[0]?.key).toBe(
      // next week's Monday
      week.periodStartDay,
    );
    expect(dayKeyToWeekKey(hits[0]!.key)).toBe(week.scaffoldKey);
    expect(hits[1]?.key.endsWith("-01")).toBe(true);
    expect(hits[2]?.key).toBe(`${year.scaffoldKey}-01-01`);
  });
});

describe("pickerDateLabel", () => {
  test("short for near relatives, formatDateFull otherwise", () => {
    expect(pickerDateLabel("2026-07-25", "2026-07-25")).toBe("Today");
    expect(pickerDateLabel("2026-07-26", "2026-07-25")).toBe("Tomorrow");
    expect(pickerDateLabel("2026-07-24", "2026-07-25")).toBe("Yesterday");
    expect(pickerDateLabel("2026-01-29", "2026-07-25")).toBe(
      formatDateFull("2026-01-29"),
    );
  });
});

describe("goToDateLabel", () => {
  test("short for near relatives, full otherwise", () => {
    expect(goToDateLabel("2026-07-25", "2026-07-25")).toBe("Go to Today");
    expect(goToDateLabel("2026-07-26", "2026-07-25")).toBe("Go to Tomorrow");
    expect(goToDateLabel("2026-07-24", "2026-07-25")).toBe("Go to Yesterday");
    expect(goToDateLabel("2026-08-12", "2026-07-25")).toBe(
      `Go to ${formatDateFull("2026-08-12")}`,
    );
  });
});

describe("parseDatePickerQuery (stricter [[ picker gate)", () => {
  test("ISO and relatives still work", () => {
    const iso = parseDatePickerQuery("2026-08-12", NOW);
    expect(iso?.key).toBe("2026-08-12");
    expect(iso?.label).toBe(formatDateFull("2026-08-12"));
    expect(parseDatePickerQuery("tomorrow", NOW)).toEqual({
      key: "2026-07-26",
      label: "Tomorrow",
    });
    expect(parseDatePickerQuery("tomo", NOW)?.key).toBe("2026-07-26");
  });

  test("calendar-complete chrono (day-of-month or year) is accepted", () => {
    const april = parseDatePickerQuery("April 22 2026", NOW);
    expect(april?.key).toBe("2026-04-22");
    expect(april?.label).toBe(formatDateFull("2026-04-22"));
    expect(parseDatePickerQuery("Aug 12", NOW)?.key).toBe("2026-08-12");
    expect(parseDatePickerQuery("April 2026", NOW)?.key).toBe("2026-04-01");
  });

  test("weekday phrases allowed; bare month still blocked", () => {
    expect(parseDatePickerQuery("April", NOW)).toBeNull();
    expect(parseDatePickerQuery("Monday", NOW)?.key).toBe("2026-07-27");
    expect(parseDatePickerQuery("Friday", NOW)?.key).toBe("2026-07-31");
    expect(parseDatePickerQuery("next Monday", NOW)?.key).toBe("2026-07-27");
    expect(parseDatePickerQuery("Thursday", NOW)?.key).toBe("2026-07-30");
    expect(parseDatePickerQuery("thursd", NOW)?.key).toBe("2026-07-30");
  });

  test("period → period-start day (not scaffold)", () => {
    const nextWeek = resolvePeriod("next", "week", TODAY)!;
    expect(parseDatePickerQuery("next week", NOW)?.key).toBe(
      nextWeek.periodStartDay,
    );
    const nextMonth = resolvePeriod("next", "month", TODAY)!;
    expect(parseDatePickerQuery("next month", NOW)?.key).toBe(
      nextMonth.periodStartDay,
    );
  });
});

describe("pickerDateSuggestions", () => {
  test("merges relatives with gated NL and dedupes by key", () => {
    const tomo = pickerDateSuggestions("tomo", NOW);
    expect(tomo).toEqual([{ key: "2026-07-26", label: "Tomorrow" }]);
    const april = pickerDateSuggestions("April 22 2026", NOW);
    expect(april).toEqual([
      { key: "2026-04-22", label: formatDateFull("2026-04-22") },
    ]);
    const iso = pickerDateSuggestions("2026-01-29", NOW);
    expect(iso).toEqual([
      { key: "2026-01-29", label: formatDateFull("2026-01-29") },
    ]);
    expect(pickerDateSuggestions("April", NOW)).toEqual([]);
  });

  test("catalog trio surfaces Next week/month/year", () => {
    const rows = pickerDateSuggestions("next", NOW);
    expect(rows.map((r) => r.label)).toEqual([
      "Next week",
      "Next month",
      "Next year",
    ]);
  });
});

describe("resolvePeriod (ISO dual-resolve math)", () => {
  test("next/last week use ISO Monday, not mid-week", () => {
    // Sat 2026-07-25 is ISO week 2026-W30 (Mon Jul 20 … Sun Jul 26)
    const thisWeek = dayKeyToWeekKey(TODAY)!;
    expect(thisWeek).toBe("2026-W30");
    const next = resolvePeriod("next", "week", TODAY)!;
    expect(next.scaffoldKey).toBe("2026-W31");
    expect(next.periodStartDay).toBe("2026-07-27"); // Monday
    const last = resolvePeriod("last", "week", TODAY)!;
    expect(last.scaffoldKey).toBe("2026-W29");
    expect(last.periodStartDay).toBe("2026-07-13");
  });

  test("next/last month → 1st; year → Jan 1", () => {
    const nextM = resolvePeriod("next", "month", TODAY)!;
    expect(nextM.scaffoldKey).toBe(shiftMonthKey("2026-07", 1)!);
    expect(nextM.periodStartDay).toBe("2026-08-01");
    const nextY = resolvePeriod("next", "year", TODAY)!;
    expect(nextY.scaffoldKey).toBe("2027");
    expect(nextY.periodStartDay).toBe("2027-01-01");
  });
});
