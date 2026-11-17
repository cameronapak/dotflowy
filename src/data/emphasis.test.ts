import { expect, test } from "bun:test";

import { emphasisAt, stripEmphasis, type EmphasisRun } from "./emphasis";

test.each<[string, EmphasisRun["kind"], string]>([
  ["*hi*", "italic", "*"],
  ["**hi**", "bold", "**"],
  ["_hi_", "italic", "_"],
  ["__hi__", "bold", "__"],
  ["~~done~~", "strike", "~~"],
  ["~under~", "underline", "~"],
  ["_THIS **IS** ITALIC_", "italic", "_"],
  ["*a **b** c*", "italic", "*"],
  ["**a *b* c**", "bold", "**"],
  ["***both***", "italic", "*"],
  ["***bold** italic*", "italic", "*"],
  ["***italic* bold**", "bold", "**"],
  ["**foo*bar**", "bold", "**"],
  ["*foo**bar*", "italic", "*"],
  ["*foo**bar**baz*", "italic", "*"],
])("balanced emphasis %p", (source, kind, marker) => {
  expect(emphasisAt(source, 0)).toEqual({
    start: 0,
    end: source.length,
    marker,
    kind,
  });
});

test.each([
  "*unclosed",
  "**also unclosed",
  "* hi*",
  "snake_case_here",
  "word_italic_",
  "\\*literal*",
])("leaves invalid or literal %p alone", (source) => {
  const start = source.search(/[*_~]/);
  expect(emphasisAt(source, start)).toBeNull();
  expect(stripEmphasis(source)).toBe(source);
});

test.each([
  ["*italic*", "italic"],
  ["**bold**", "bold"],
  ["~~strike~~", "strike"],
  ["~underline~", "underline"],
  ["_italic_", "italic"],
  ["__bold__", "bold"],
  ["_THIS **IS** ITALIC_ ", "THIS IS ITALIC "],
  ["***triple***", "triple"],
  ["___triple___", "triple"],
  ["~~~strike underline~~~", "strike underline"],
  [
    "**outer *middle **inner** middle* outer**",
    "outer middle inner middle outer",
  ],
  ["**one** gap **two**", "one gap two"],
  ["**unclosed **valid**", "**unclosed valid"],
  ["*open *open end*", "*open open end"],
  ["a *b* c **d** e", "a b c d e"],
  ["call foo_bar_baz()", "call foo_bar_baz()"],
  ["no emphasis here", "no emphasis here"],
])("stripEmphasis(%p) -> %p", (source, expected) => {
  expect(stripEmphasis(source)).toBe(expected);
});
