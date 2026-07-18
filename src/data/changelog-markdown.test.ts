import { describe, expect, test } from "bun:test";

import { parseInlineMarkdown } from "./changelog-markdown";

describe("parseInlineMarkdown", () => {
  test("plain prose is one text segment", () => {
    expect(parseInlineMarkdown("Nothing to see.")).toEqual([
      { kind: "text", value: "Nothing to see." },
    ]);
  });

  test("splits bold out of the surrounding text", () => {
    expect(parseInlineMarkdown("**Relearn one gesture:** the header")).toEqual([
      { kind: "strong", value: "Relearn one gesture:" },
      { kind: "text", value: " the header" },
    ]);
  });

  test("reads several runs in one line", () => {
    expect(parseInlineMarkdown("Use `q`, then **Enter** to file.")).toEqual([
      { kind: "text", value: "Use " },
      { kind: "code", value: "q" },
      { kind: "text", value: ", then " },
      { kind: "strong", value: "Enter" },
      { kind: "text", value: " to file." },
    ]);
  });

  test("a code span shields its interior -- the editor's own precedence", () => {
    expect(parseInlineMarkdown("`**not bold**`")).toEqual([
      { kind: "code", value: "**not bold**" },
    ]);
  });

  test("an unclosed marker renders verbatim, never vanishes", () => {
    expect(parseInlineMarkdown("**oops and `stray")).toEqual([
      { kind: "text", value: "**oops and `stray" },
    ]);
  });

  test("keeps the paragraph breaks reflow preserved", () => {
    expect(parseInlineMarkdown("One **a**.\n\nTwo.")).toEqual([
      { kind: "text", value: "One " },
      { kind: "strong", value: "a" },
      { kind: "text", value: ".\n\nTwo." },
    ]);
  });

  test("a run cannot span a paragraph break", () => {
    const parsed = parseInlineMarkdown("**one\n\ntwo**");
    expect(parsed).toEqual([{ kind: "text", value: "**one\n\ntwo**" }]);
  });
});
