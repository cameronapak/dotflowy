import { describe, expect, test } from "bun:test";

import { stripCode, stripCodeShielded } from "./code";

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

describe("stripCodeShielded", () => {
  // Upper-cases only the text OUTSIDE code runs, proving the interior is masked
  // from `stripRest` and restored verbatim.
  const shout = (text: string) =>
    stripCodeShielded(text, (masked) => masked.toUpperCase());

  test("shields the code interior from stripRest, keeps text around it", () => {
    expect(shout("loud `quiet` loud")).toBe("LOUD quiet LOUD");
  });

  test("stripRest still runs when there is no code run", () => {
    expect(shout("all loud")).toBe("ALL LOUD");
  });

  test("an unclosed backtick masks nothing -- stripRest sees it all", () => {
    expect(shout("a `stray tick")).toBe("A `STRAY TICK");
  });

  test("stripRest can strip markers WRAPPING a code run", () => {
    // The mask leaves the wrapping markers exposed, so a strip that eats them
    // (here: drop every `*`) reaches them while the interior stays verbatim.
    const dropStars = (text: string) =>
      stripCodeShielded(text, (masked) => masked.replaceAll("*", ""));
    expect(dropStars("**`*keep*`**")).toBe("*keep*");
  });
});
