import { expect, test } from "bun:test";

import type { HighlightParts } from "./highlight";

import {
  buildHighlightRun,
  HIGHLIGHT_PATTERN,
  hasHighlight,
  parseHighlight,
  stripHighlights,
} from "./highlight";

test.each([
  ["a ==hi== b", ["==hi=="]],
  ["==🔴urgent==", ["==🔴urgent=="]], // emoji bound to the color slot
  ["==a== ==b==", ["==a==", "==b=="]],
  ["==unclosed", []],
  ["==a=b==", []], // interior may not contain `=` (flat, like emphasis)
  // Liberal edge spaces: the same over-match class `**` accepts.
  ["a == b == c", ["== b =="]],
])("HIGHLIGHT_PATTERN in %p matches %p", (text, expected) => {
  const runs = [...text.matchAll(new RegExp(HIGHLIGHT_PATTERN, "gu"))].map(
    (m) => m[0],
  );
  expect(runs).toEqual(expected);
});

test.each<[string, HighlightParts]>([
  ["==hi==", { color: "blue", emoji: null, interior: "hi" }], // bare = default
  ["==🔴urgent==", { color: "red", emoji: "🔴", interior: "urgent" }],
  ["==🟡note==", { color: "yellow", emoji: "🟡", interior: "note" }],
  ["==🟣deep==", { color: "purple", emoji: "🟣", interior: "deep" }],
  // An emoji-ONLY interior is a default-color highlight of the emoji: the
  // regex's `[emoji]?` yields when `[^=]+` would otherwise be empty.
  ["==🔵==", { color: "blue", emoji: null, interior: "🔵" }],
  // A non-palette emoji is just interior text.
  ["==🎉party==", { color: "blue", emoji: null, interior: "🎉party" }],
])("parseHighlight(%p)", (run, expected) => {
  expect(parseHighlight(run)).toEqual(expected);
});

test("buildHighlightRun emits the bare form for blue and an emoji otherwise, and round-trips", () => {
  expect(buildHighlightRun("blue", "hi")).toBe("==hi==");
  expect(buildHighlightRun("red", "hi")).toBe("==🔴hi==");
  expect(buildHighlightRun("green", "hi")).toBe("==🟢hi==");
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

test("stripHighlights drops fences and the color emoji, keeps everything else", () => {
  expect(stripHighlights("a ==hi== and ==🔴urgent== b")).toBe(
    "a hi and urgent b",
  );
  expect(stripHighlights("plain = text == still plain")).toBe(
    "plain = text == still plain",
  );
});

test("hasHighlight is true for a run, false for stray fences", () => {
  expect(hasHighlight("==hi==")).toBe(true);
  expect(hasHighlight("a == b")).toBe(false);
  expect(hasHighlight("plain")).toBe(false);
});
