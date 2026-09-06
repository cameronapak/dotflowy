import { describe, expect, test } from "bun:test";

import { centerScrollDelta } from "./spotlight";

describe("centerScrollDelta", () => {
  test("desktop centers the row in the visual viewport", () => {
    // row top 400, height 40 → row center 420; view 0×800 → view center 400
    expect(centerScrollDelta(400, 40, 0, 800)).toBe(20);
  });

  test("desktop with a visualViewport offset still centers", () => {
    // row center 120; view top 50, height 600 → view center 350
    expect(centerScrollDelta(100, 40, 50, 600)).toBe(-230);
  });

  test("desktop ignores sticky header height", () => {
    expect(centerScrollDelta(400, 40, 0, 800, 56, false)).toBe(20);
    expect(centerScrollDelta(400, 40, 0, 800, 56, false)).toBe(
      centerScrollDelta(400, 40, 0, 800),
    );
  });

  test("mobile top-aligns just below the sticky header", () => {
    expect(centerScrollDelta(400, 40, 0, 800, 56, true)).toBe(344);
  });

  test("mobile subtracts visualViewport offset and header, not row height", () => {
    expect(centerScrollDelta(100, 80, 50, 600, 56, true)).toBe(-6);
  });
});
