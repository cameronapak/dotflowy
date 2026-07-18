import { describe, expect, test } from "bun:test";

import { flattenInline } from "./inline-text";

describe("flattenInline", () => {
  test("markup-free text passes through untouched", () => {
    expect(flattenInline("plain reading text")).toBe("plain reading text");
  });

  test("strips emphasis, highlight and spoiler markers outside code", () => {
    expect(flattenInline("**bold** ==🔴hot== ||secret||")).toBe(
      "bold hot secret",
    );
  });

  test("flattens a link to its label", () => {
    expect(flattenInline("see [the docs](https://x.com)")).toBe("see the docs");
  });

  // The real bug: the code plugin's precedence (code 10 < emphasis 30) shields a
  // run's interior, so the editor draws `` `**x**` `` as a code chip reading
  // `**x**`. Flatten must agree -- NOT eat the asterisks.
  test("a code span shields its emphasis interior", () => {
    expect(flattenInline("`**x**`")).toBe("**x**");
  });

  test("code interiors keep strike and highlight markers verbatim", () => {
    expect(flattenInline("`~~strike~~`")).toBe("~~strike~~");
    expect(flattenInline("`==highlight==`")).toBe("==highlight==");
  });

  // An emphasis run WRAPPING a code run: the bold markers are outside the code
  // interior, so they still strip; the shielded interior then drops its ticks.
  test("emphasis wrapping code strips the emphasis, then the ticks", () => {
    expect(flattenInline("**`code`**")).toBe("code");
  });

  test("mixes shielded and unshielded runs in one line", () => {
    expect(flattenInline("run `**verbatim**` but **flatten** this")).toBe(
      "run **verbatim** but flatten this",
    );
  });

  test("an unclosed backtick is safe -- markup around it still flattens", () => {
    expect(flattenInline("a `stray tick with **bold**")).toBe(
      "a `stray tick with bold",
    );
  });

  test("back-to-back code runs each keep their interior", () => {
    expect(flattenInline("`*a*` `*b*`")).toBe("*a* *b*");
  });
});
