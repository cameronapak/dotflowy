import { expect, test } from "bun:test";

import { flattenInline } from "./inline-text";

// The code plugin's precedence (code 10 < emphasis 30) shields a run's
// interior, so the editor draws `` `**x**` `` as a code chip reading `**x**`.
// Flatten must agree and NOT eat the asterisks.
test.each([
  ["plain reading text", "plain reading text"],
  ["**bold** ==🔴hot== ||secret||", "bold hot secret"],
  ["see [the docs](https://x.com)", "see the docs"],
  ["`**x**`", "**x**"], // a code span shields its emphasis interior
  ["`~~strike~~`", "~~strike~~"],
  ["`==highlight==`", "==highlight=="],
  // Emphasis WRAPPING code: the bold markers sit outside the code interior, so
  // they still strip; the shielded interior then drops its ticks.
  ["**`code`**", "code"],
  [
    "run `**verbatim**` but **flatten** this",
    "run **verbatim** but flatten this",
  ],
  // An unclosed backtick is safe: markup around it still flattens.
  ["a `stray tick with **bold**", "a `stray tick with bold"],
  ["`*a*` `*b*`", "*a* *b*"],
])("flattenInline(%p) -> %p", (text, expected) => {
  expect(flattenInline(text)).toBe(expected);
});
