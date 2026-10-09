import { expect, test } from "bun:test";

import { centerScrollDelta } from "./spotlight";

// centerScrollDelta(rowTop, rowHeight, viewTop, viewHeight, header?, mobile?)
test.each<[string, Parameters<typeof centerScrollDelta>, number]>([
  // row center 420; view center 400
  ["desktop centers the row in the visual viewport", [400, 40, 0, 800], 20],
  // row center 120; view top 50, height 600 -> view center 350
  ["desktop centers with a visualViewport offset", [100, 40, 50, 600], -230],
  ["desktop ignores sticky header height", [400, 40, 0, 800, 56, false], 20],
  [
    "mobile top-aligns below the sticky header",
    [400, 40, 0, 800, 56, true],
    344,
  ],
  [
    "mobile subtracts viewport offset and header, not row height",
    [100, 80, 50, 600, 56, true],
    -6,
  ],
])("centerScrollDelta: %s", (_name, args, expected) => {
  expect(centerScrollDelta(...args)).toBe(expected);
});
