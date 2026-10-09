import { expect, test } from "bun:test";

import { type InlineSegment, parseInlineMarkdown } from "./changelog-markdown";

test.each<[string, string, InlineSegment[]]>([
  [
    "plain prose is one text segment",
    "Nothing to see.",
    [{ kind: "text", value: "Nothing to see." }],
  ],
  [
    "splits bold out of the surrounding text",
    "**Relearn one gesture:** the header",
    [
      { kind: "strong", value: "Relearn one gesture:" },
      { kind: "text", value: " the header" },
    ],
  ],
  [
    "reads several runs in one line",
    "Use `q`, then **Enter** to file.",
    [
      { kind: "text", value: "Use " },
      { kind: "code", value: "q" },
      { kind: "text", value: ", then " },
      { kind: "strong", value: "Enter" },
      { kind: "text", value: " to file." },
    ],
  ],
  [
    "a code span shields its interior, the editor's own precedence",
    "`**not bold**`",
    [{ kind: "code", value: "**not bold**" }],
  ],
  [
    "an unclosed marker renders verbatim, never vanishes",
    "**oops and `stray",
    [{ kind: "text", value: "**oops and `stray" }],
  ],
  [
    "keeps the paragraph breaks reflow preserved",
    "One **a**.\n\nTwo.",
    [
      { kind: "text", value: "One " },
      { kind: "strong", value: "a" },
      { kind: "text", value: ".\n\nTwo." },
    ],
  ],
  [
    "a run cannot span a paragraph break",
    "**one\n\ntwo**",
    [{ kind: "text", value: "**one\n\ntwo**" }],
  ],
])("parseInlineMarkdown: %s", (_name, source, expected) => {
  expect(parseInlineMarkdown(source)).toEqual(expected);
});
