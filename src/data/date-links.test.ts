import { describe, expect, test } from "bun:test";

import {
  DATE_LINK_PATTERN,
  addDays,
  dateSuggestions,
  flattenDateLinks,
  formatDateLabel,
  isValidDateKey,
  localDateKey,
  parseDateLink,
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
