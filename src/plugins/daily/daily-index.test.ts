import { expect, test } from "bun:test";

import {
  formatDayBadge,
  formatDayRelative,
  formatDayText,
} from "./daily-index";

test.each([
  ["2026-06-23", "Today", "Today"],
  ["2026-06-22", "Yesterday", "Yesterday"],
  ["2026-06-24", "Tomorrow", "Tomorrow"],
  // Beyond +/-1 the relative label is null and the badge is a short date.
  ["2026-06-20", null, "Jun 20"],
  ["2026-01-15", null, "Jan 15"],
  ["not-a-date", null, "not-a-date"],
])("on 2026-06-23, %s -> relative %p, badge %p", (key, relative, badge) => {
  expect(formatDayRelative(key, "2026-06-23")).toBe(relative);
  expect(formatDayBadge(key, "2026-06-23")).toBe(badge);
});

test("formatDayText is the full date, or the raw key when malformed", () => {
  expect(formatDayText("2026-06-23")).toBe("Tuesday, June 23, 2026");
  expect(formatDayText("garbage")).toBe("garbage");
});
