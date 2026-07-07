import { describe, expect, it } from "bun:test";
import { detectMarkerWrap, planMarkerToggle } from "./inline-wrap";

const BOLD = { pre: "**", post: "**" };
const ITALIC = { pre: "*", post: "*" };
const STRIKE = { pre: "~~", post: "~~" };
const UNDER = { pre: "~", post: "~" };
const MARK = { pre: "==", post: "==" };

describe("detectMarkerWrap", () => {
  it("detects a marker-inclusive selection (folded atom picked up whole)", () => {
    expect(detectMarkerWrap("**bold**", 0, 8, BOLD)).toBe("inside");
    expect(detectMarkerWrap("a *hi* b", 2, 6, ITALIC)).toBe("inside");
  });

  it("detects markers flanking an inner selection", () => {
    // "**bold**" with just "bold" (offsets 2..6) selected.
    expect(detectMarkerWrap("**bold**", 2, 6, BOLD)).toBe("outside");
    expect(detectMarkerWrap("*hi*", 1, 3, ITALIC)).toBe("outside");
  });

  it("returns null when the selection is plain text", () => {
    expect(detectMarkerWrap("bold", 0, 4, BOLD)).toBeNull();
    expect(detectMarkerWrap("hello world", 0, 5, ITALIC)).toBeNull();
  });

  it("does NOT mistake a doubled marker for the single (** is not *)", () => {
    // Selecting a whole bold run must not read as italic-active.
    expect(detectMarkerWrap("**b**", 0, 5, ITALIC)).toBeNull();
    // Inner selection of bold must not read as italic-active either.
    expect(detectMarkerWrap("**b**", 2, 3, ITALIC)).toBeNull();
    // ~~ vs ~ (strike vs underline).
    expect(detectMarkerWrap("~~s~~", 0, 5, UNDER)).toBeNull();
    expect(detectMarkerWrap("~~s~~", 2, 3, UNDER)).toBeNull();
  });

  it("still detects the genuine single-char run", () => {
    expect(detectMarkerWrap("*i*", 0, 3, ITALIC)).toBe("inside");
    expect(detectMarkerWrap("~u~", 0, 3, UNDER)).toBe("inside");
  });

  it("detects a highlight run including its color emoji", () => {
    // 🔴 is a surrogate pair (2 UTF-16 units), so the run is 12 units long.
    expect(detectMarkerWrap("==\u{1F534}urgent==", 0, 12, MARK)).toBe("inside");
  });
});

describe("planMarkerToggle", () => {
  it("wraps a plain selection and re-selects the interior", () => {
    const plan = planMarkerToggle("hello", 0, 5, BOLD);
    expect(plan.removed).toBe(false);
    expect(plan.next).toBe("**hello**");
    // Interior "hello" sits at offsets 2..7 in the new source.
    expect(plan.range).toEqual({ start: 2, end: 7 });
  });

  it("inserts an empty pair with a collapsed caret when nothing is selected", () => {
    const plan = planMarkerToggle("", 0, 0, BOLD);
    expect(plan.removed).toBe(false);
    expect(plan.next).toBe("****");
    expect(plan.range).toEqual({ start: 2, end: 2 });
  });

  it("unwraps a marker-inclusive selection", () => {
    const plan = planMarkerToggle("**bold**", 0, 8, BOLD);
    expect(plan.removed).toBe(true);
    expect(plan.next).toBe("bold");
    expect(plan.range).toEqual({ start: 0, end: 4 });
  });

  it("unwraps when the markers flank the selection", () => {
    // "x **bold** y", select "bold" (offsets 4..8).
    const plan = planMarkerToggle("x **bold** y", 4, 8, BOLD);
    expect(plan.removed).toBe(true);
    expect(plan.next).toBe("x bold y");
    expect(plan.range).toEqual({ start: 2, end: 6 });
  });

  it("round-trips wrap then unwrap to the original", () => {
    const src = "the word here";
    const on = planMarkerToggle(src, 4, 8, STRIKE); // "word"
    expect(on.next).toBe("the ~~word~~ here");
    // Re-selecting the interior lands markers OUTSIDE the selection.
    const off = planMarkerToggle(on.next, on.range.start, on.range.end, STRIKE);
    expect(off.removed).toBe(true);
    expect(off.next).toBe(src);
  });
});
