import { describe, expect, test } from "bun:test";
import {
  buildHighlightRun,
  HIGHLIGHT_PATTERN,
  hasHighlight,
  parseHighlight,
  spliceHighlightRun,
  stripHighlights,
} from "./highlight";

const matches = (text: string): string[] =>
  [...text.matchAll(new RegExp(HIGHLIGHT_PATTERN, "gu"))].map((m) => m[0]);

describe("HIGHLIGHT_PATTERN", () => {
  test("matches a bare run", () => {
    expect(matches("a ==hi== b")).toEqual(["==hi=="]);
  });

  test("matches a colored run, emoji bound to the color slot", () => {
    expect(matches("==🔴urgent==")).toEqual(["==🔴urgent=="]);
  });

  test("back-to-back runs both match", () => {
    expect(matches("==a== ==b==")).toEqual(["==a==", "==b=="]);
  });

  test("an unclosed fence stays literal", () => {
    expect(matches("==unclosed")).toEqual([]);
  });

  test("interior may not contain `=` (flat, like emphasis)", () => {
    expect(matches("==a=b==")).toEqual([]);
  });

  test("liberal edge spaces, mirroring the emphasis patterns", () => {
    // `a == b == c` highlights " b " -- the same over-match class `**` accepts.
    expect(matches("a == b == c")).toEqual(["== b =="]);
  });
});

describe("parseHighlight", () => {
  test("bare run is the default color (blue)", () => {
    expect(parseHighlight("==hi==")).toEqual({
      color: "blue",
      emoji: null,
      interior: "hi",
    });
  });

  test("leading emoji names the color and leaves the interior", () => {
    expect(parseHighlight("==🔴urgent==")).toEqual({
      color: "red",
      emoji: "🔴",
      interior: "urgent",
    });
    expect(parseHighlight("==🟡note==").color).toBe("yellow");
    expect(parseHighlight("==🟣deep==").color).toBe("purple");
  });

  test("an emoji-ONLY interior is a default-color highlight of the emoji", () => {
    // Mirrors the regex backtracking: `[emoji]?` yields when `[^=]+` would
    // otherwise be empty.
    expect(parseHighlight("==🔵==")).toEqual({
      color: "blue",
      emoji: null,
      interior: "🔵",
    });
  });

  test("a NON-palette emoji is just interior text", () => {
    expect(parseHighlight("==🎉party==")).toEqual({
      color: "blue",
      emoji: null,
      interior: "🎉party",
    });
  });
});

describe("buildHighlightRun", () => {
  test("the default color emits the bare form", () => {
    expect(buildHighlightRun("blue", "hi")).toBe("==hi==");
  });

  test("other colors carry their emoji", () => {
    expect(buildHighlightRun("red", "hi")).toBe("==🔴hi==");
    expect(buildHighlightRun("green", "hi")).toBe("==🟢hi==");
  });

  test("build/parse round-trip", () => {
    for (const color of [
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
    ] as const) {
      expect(parseHighlight(buildHighlightRun(color, "x")).color).toBe(color);
    }
  });
});

describe("stripHighlights", () => {
  test("drops fences and the color emoji, keeps everything else", () => {
    expect(stripHighlights("a ==hi== and ==🔴urgent== b")).toBe(
      "a hi and urgent b",
    );
  });

  test("highlight-free text passes through untouched", () => {
    expect(stripHighlights("plain = text == still plain")).toBe(
      "plain = text == still plain",
    );
  });
});

describe("hasHighlight", () => {
  test("true for a run, false for stray fences", () => {
    expect(hasHighlight("==hi==")).toBe(true);
    expect(hasHighlight("a == b")).toBe(false);
    expect(hasHighlight("plain")).toBe(false);
  });
});

describe("spliceHighlightRun", () => {
  test("replaces the first verbatim occurrence", () => {
    expect(spliceHighlightRun("a ==hi== b", "==hi==", "==🔴hi==")).toBe(
      "a ==🔴hi== b",
    );
  });

  test("drops the edit when the run is gone (stale token)", () => {
    expect(spliceHighlightRun("edited away", "==hi==", "==🔴hi==")).toBeNull();
  });
});
