import { expect, test } from "bun:test";

import { isRevealed, spliceToken } from "./token-kit";

test.each([
  [null, false], // no caret is never revealed
  [1, false], // before start
  [2, true], // at start (inclusive)
  [3, true], // inside
  [5, true], // at end (inclusive)
  [6, false], // past end
])("isRevealed with caret %p on span 2..5 -> %p", (revealOffset, expected) => {
  expect(isRevealed({ revealOffset, start: 2, end: 5 })).toBe(expected);
});

test("spliceToken replaces only the first occurrence, or returns null once the token is gone", () => {
  expect(spliceToken("a [x](y) b", "[x](y)", "[z](y)")).toBe("a [z](y) b");
  expect(spliceToken("aa bb aa", "aa", "cc")).toBe("cc bb aa");
  expect(spliceToken("edited away", "[x](y)", "[z](y)")).toBeNull();
});
