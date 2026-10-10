import { expect, test } from "bun:test";

import { stripCodeShielded } from "./code";

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
