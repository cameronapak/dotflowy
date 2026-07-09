import { describe, expect, test } from "bun:test";
import { isRevealed, spliceToken } from "./token-kit";

describe("isRevealed", () => {
  test("null caret is never revealed", () => {
    expect(isRevealed({ revealOffset: null, start: 2, end: 5 })).toBe(false);
  });

  test("offset before start is not revealed", () => {
    expect(isRevealed({ revealOffset: 1, start: 2, end: 5 })).toBe(false);
  });

  test("offset at start is revealed (inclusive boundary)", () => {
    expect(isRevealed({ revealOffset: 2, start: 2, end: 5 })).toBe(true);
  });

  test("offset inside the span is revealed", () => {
    expect(isRevealed({ revealOffset: 3, start: 2, end: 5 })).toBe(true);
  });

  test("offset at end is revealed (inclusive boundary)", () => {
    expect(isRevealed({ revealOffset: 5, start: 2, end: 5 })).toBe(true);
  });

  test("offset past end is not revealed", () => {
    expect(isRevealed({ revealOffset: 6, start: 2, end: 5 })).toBe(false);
  });
});

describe("spliceToken", () => {
  test("replaces the first occurrence", () => {
    expect(spliceToken("a [x](y) b", "[x](y)", "[z](y)")).toBe("a [z](y) b");
  });

  test("returns null when the token is missing", () => {
    expect(spliceToken("edited away", "[x](y)", "[z](y)")).toBeNull();
  });

  test("only the first occurrence is replaced when the token appears twice", () => {
    expect(spliceToken("aa bb aa", "aa", "cc")).toBe("cc bb aa");
  });

  test("searchFrom targets the occurrence at-or-after the given offset", () => {
    // Two identical tokens; the second one starts at index 6. Editing the
    // clicked (second) chip must not mutate the first.
    expect(spliceToken("aa bb aa", "aa", "cc", 6)).toBe("aa bb cc");
  });

  test("searchFrom lands on the exact clicked occurrence (John 3 twice)", () => {
    const text = "John 3 and John 3";
    // First chip at 0, second at 11.
    expect(spliceToken(text, "John 3", "John 3:16", 11)).toBe(
      "John 3 and John 3:16",
    );
    expect(spliceToken(text, "John 3", "John 3:16", 0)).toBe(
      "John 3:16 and John 3",
    );
  });

  test("searchFrom past the last occurrence drops (returns null)", () => {
    expect(spliceToken("aa bb aa", "aa", "cc", 7)).toBeNull();
  });
});
