import { expect, test } from "bun:test";

import { formatDayBadge, formatDayRelative } from "./daily-index";

test.each([
  ["2026-06-23", "Today", "Today"],
  ["2026-06-22", "Yesterday", "Yesterday"],
  ["2026-06-24", "Tomorrow", "Tomorrow"],
  // Beyond +/-1 the relative label is null and the badge is a short date.
  ["2026-06-20", null, "Jun 20"],
  ["not-a-date", null, "not-a-date"],
])("on 2026-06-23, %s -> relative %p, badge %p", (key, relative, badge) => {
  expect(formatDayRelative(key, "2026-06-23")).toBe(relative);
  expect(formatDayBadge(key, "2026-06-23")).toBe(badge);
});
