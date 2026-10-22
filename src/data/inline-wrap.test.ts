import { expect, test } from "bun:test";

import { detectMarkerWrap, planMarkerToggle } from "./inline-wrap";

const BOLD = { pre: "**", post: "**" };
const ITALIC = { pre: "*", post: "*" };
const STRIKE = { pre: "~~", post: "~~" };
const MARK = { pre: "==", post: "==" };

test.each<
  [
    string,
    number,
    number,
    Parameters<typeof detectMarkerWrap>[3],
    ReturnType<typeof detectMarkerWrap>,
  ]
>([
  // A marker-inclusive selection (the folded atom picked up whole).
  ["**bold**", 0, 8, BOLD, "inside"],
  ["a *hi* b", 2, 6, ITALIC, "inside"],
  // 🔴 is a surrogate pair (2 UTF-16 units), so the run is 12 units long.
  ["==\u{1F534}urgent==", 0, 12, MARK, "inside"],
  // Markers flanking an inner selection.
  ["**bold**", 2, 6, BOLD, "outside"],
  // Plain text.
  ["bold", 0, 4, BOLD, null],
  // A doubled marker is not the single one, whole or inner.
  ["**b**", 0, 5, ITALIC, null],
  ["**b**", 2, 3, ITALIC, null],
])(
  "detectMarkerWrap(%p, %d, %d, %o) -> %p",
  (text, start, end, marker, expected) => {
    expect(detectMarkerWrap(text, start, end, marker)).toBe(expected);
  },
);

test("wraps and unwraps a selection without changing surrounding text or selection", () => {
  const on = planMarkerToggle("the word here", 4, 8, STRIKE);
  expect(on).toEqual({
    removed: false,
    next: "the ~~word~~ here",
    range: { start: 6, end: 10 },
  });
  const off = planMarkerToggle(on.next, on.range.start, on.range.end, STRIKE);
  expect(off).toEqual({
    removed: true,
    next: "the word here",
    range: { start: 4, end: 8 },
  });
});

test("inserts an empty pair with a collapsed caret when nothing is selected", () => {
  const plan = planMarkerToggle("", 0, 0, BOLD);
  expect(plan.removed).toBe(false);
  expect(plan.next).toBe("****");
  expect(plan.range).toEqual({ start: 2, end: 2 });
});

test("unwraps a marker-inclusive selection", () => {
  const plan = planMarkerToggle("**bold**", 0, 8, BOLD);
  expect(plan.removed).toBe(true);
  expect(plan.next).toBe("bold");
  expect(plan.range).toEqual({ start: 0, end: 4 });
});

test("unwraps when the markers flank the selection", () => {
  // "x **bold** y", select "bold" (offsets 4..8).
  const plan = planMarkerToggle("x **bold** y", 4, 8, BOLD);
  expect(plan.removed).toBe(true);
  expect(plan.next).toBe("x bold y");
  expect(plan.range).toEqual({ start: 2, end: 6 });
});
