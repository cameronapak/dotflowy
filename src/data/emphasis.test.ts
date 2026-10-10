import { expect, test } from "bun:test";

import {
  BOLD_PATTERN,
  emphasisMarkerLen,
  ITALIC_PATTERN,
  ITALIC_UNDERSCORE_PATTERN,
  STRIKETHROUGH_PATTERN,
  stripEmphasis,
  UNDERLINE_PATTERN,
} from "./emphasis";

// `u` flag: the underscore-italic pattern uses `\p{L}`/`\p{N}`, which are only
// property escapes under a unicode regex (and the combined token regex is
// `gu`). Harmless for the `*`/`~` patterns.
test.each([
  ["italic", ITALIC_PATTERN, "*hi*", true],
  ["italic", ITALIC_PATTERN, "a *hi* b", false], // anchored: has a prefix
  ["italic", ITALIC_PATTERN, "*a*b*c*", false], // no nesting v1
  ["bold", BOLD_PATTERN, "**hi**", true],
  ["bold", BOLD_PATTERN, "*hi*", false], // single-* is italic, not bold
  ["bold", BOLD_PATTERN, "**a*b*c**", false],
  ["strikethrough", STRIKETHROUGH_PATTERN, "~~done~~", true],
  ["underline", UNDERLINE_PATTERN, "~under~", true],
  ["underline", UNDERLINE_PATTERN, "~a~b~", false],
  ["underscore italic", ITALIC_UNDERSCORE_PATTERN, "_hi_", true],
  ["underscore italic", ITALIC_UNDERSCORE_PATTERN, "_a_b_c_", false],
])("%s pattern, anchored, on %p -> %p", (_name, pattern, text, expected) => {
  expect(new RegExp(`^(?:${pattern})$`, "u").test(text)).toBe(expected);
});

// The underscore pattern's lookarounds need real neighboring context, so it
// is matched unanchored: word-bounded runs match, intraword ones stay literal.
test.each([
  ["a _hi_ b", true],
  ["(_hi_)", true],
  ["snake_case_here", false],
  ["a1_b_c2", false],
  ["word_italic_", false],
])("underscore italic, unanchored, on %p -> %p", (text, expected) => {
  expect(new RegExp(ITALIC_UNDERSCORE_PATTERN, "u").test(text)).toBe(expected);
});

test.each([
  ["*italic*", "italic"],
  ["**bold**", "bold"], // bold wins over italic on a ** run
  ["~~strike~~", "strike"], // strike wins over underline on a ~~ run
  ["~underline~", "underline"],
  ["_italic_", "italic"],
  ["call foo_bar_baz()", "call foo_bar_baz()"], // search parity with render
  ["a *b* c **d** e", "a b c d e"],
  ["no emphasis here", "no emphasis here"],
  ["snake_case_name", "snake_case_name"],
  ["*unclosed", "*unclosed"],
  ["**also unclosed", "**also unclosed"],
  // Flat v1: `**triple**` matches as bold and the leading `*` stays literal.
  ["***triple***", "*triple*"],
])("stripEmphasis(%p) -> %p", (text, expected) => {
  expect(stripEmphasis(text)).toBe(expected);
});

test.each([
  ["**bold**", 2],
  ["~~strike~~", 2],
  ["*italic*", 1],
  ["~underline~", 1],
  ["_italic_", 1],
])("emphasisMarkerLen(%p) -> %d", (run, expected) => {
  expect(emphasisMarkerLen(run)).toBe(expected);
});
