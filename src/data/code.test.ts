import { expect, test } from "bun:test";

import { stripCode, stripCodeShielded } from "./code";

test.each([
  ["run `bun test` first", "run bun test first"],
  ["nothing here", "nothing here"],
  ["`a` `b` `c`", "a b c"], // back-to-back runs: the shared-regex lastIndex trap
  ["a `stray tick", "a `stray tick"], // an unclosed backtick is left alone
  ["``", "``"], // an empty run is not a run
  ["`a\nb`", "`a\nb`"], // a run cannot span a line break
])("stripCode(%p) -> %p", (text, expected) => {
  expect(stripCode(text)).toBe(expected);
});

// Upper-cases only the text OUTSIDE code runs, proving the interior is masked
// from `stripRest` and restored verbatim.
test.each([
  ["loud `quiet` loud", "LOUD quiet LOUD"],
  ["all loud", "ALL LOUD"], // stripRest still runs with no code run
  ["a `stray tick", "A `STRAY TICK"], // an unclosed backtick masks nothing
])("stripCodeShielded(%p, upper-case) -> %p", (text, expected) => {
  expect(stripCodeShielded(text, (masked) => masked.toUpperCase())).toBe(
    expected,
  );
});

test("stripCodeShielded lets stripRest strip markers WRAPPING a code run", () => {
  // The mask leaves the wrapping markers exposed, so a strip that eats them
  // (here: drop every `*`) reaches them while the interior stays verbatim.
  expect(
    stripCodeShielded("**`*keep*`**", (masked) => masked.replaceAll("*", "")),
  ).toBe("*keep*");
});
