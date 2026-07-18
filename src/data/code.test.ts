import { describe, expect, test } from "bun:test";

import { stripCode } from "./code";

describe("stripCode", () => {
  test("drops the backticks, keeps the interior", () => {
    expect(stripCode("run `bun test` first")).toBe("run bun test first");
  });

  test("backtick-free text passes through untouched", () => {
    expect(stripCode("nothing here")).toBe("nothing here");
  });

  test("reduces back-to-back runs -- the shared-regex lastIndex trap", () => {
    expect(stripCode("`a` `b` `c`")).toBe("a b c");
  });

  test("an unclosed backtick is left alone", () => {
    expect(stripCode("a `stray tick")).toBe("a `stray tick");
  });

  test("an empty run is not a run", () => {
    expect(stripCode("``")).toBe("``");
  });

  test("a run cannot span a line break", () => {
    expect(stripCode("`a\nb`")).toBe("`a\nb`");
  });
});
