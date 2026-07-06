import { expect, test } from "bun:test";
import {
  type ParsedItem,
  normalizeDepths,
  parseMarkdownPaste,
} from "./markdown-paste";

function item(
  text: string,
  depth: number,
  isTask = false,
  completed = false,
): ParsedItem {
  return { text, depth, isTask, completed };
}

test("returns null for single-line input", () => {
  expect(parseMarkdownPaste("hello world")).toBeNull();
  expect(parseMarkdownPaste("")).toBeNull();
});

test("returns null for all-blank input", () => {
  expect(parseMarkdownPaste("\n\n")).toBeNull();
});

test("parses a simple dash list", () => {
  const input = "- Romans 5:3-6\n- 2 Corinthians 12:8-9\n- Philippians 4:11-13";
  expect(parseMarkdownPaste(input)).toEqual([
    item("Romans 5:3-6", 0),
    item("2 Corinthians 12:8-9", 0),
    item("Philippians 4:11-13", 0),
  ]);
});

test("strips asterisk and plus markers", () => {
  const input = "* one\n+ two\n- three";
  expect(parseMarkdownPaste(input)).toEqual([
    item("one", 0),
    item("two", 0),
    item("three", 0),
  ]);
});

test("strips ordered list markers", () => {
  const input = "1. first\n2. second\n10. tenth";
  expect(parseMarkdownPaste(input)).toEqual([
    item("first", 0),
    item("second", 0),
    item("tenth", 0),
  ]);
});

test("strips a trailing empty line", () => {
  const input = "- one\n- two\n";
  expect(parseMarkdownPaste(input)).toEqual([item("one", 0), item("two", 0)]);
});

test("parses nested items via indentation (2-space)", () => {
  const input = "- parent\n  - child\n    - grandchild\n- sibling";
  expect(parseMarkdownPaste(input)).toEqual([
    item("parent", 0),
    item("child", 1),
    item("grandchild", 2),
    item("sibling", 0),
  ]);
});

test("parses nested items via tabs", () => {
  const input = "- parent\n\t- child\n\t\t- grandchild";
  expect(parseMarkdownPaste(input)).toEqual([
    item("parent", 0),
    item("child", 1),
    item("grandchild", 2),
  ]);
});

test("parses task markers", () => {
  const input = "- [ ] todo\n- [x] done";
  expect(parseMarkdownPaste(input)).toEqual([
    item("todo", 0, true, false),
    item("done", 0, true, true),
  ]);
});

test("parses plain text lines as bullets", () => {
  const input = "first line\nsecond line";
  expect(parseMarkdownPaste(input)).toEqual([
    item("first line", 0),
    item("second line", 0),
  ]);
});

test("keeps empty lines as empty bullets", () => {
  const input = "- one\n\n- three";
  expect(parseMarkdownPaste(input)).toEqual([
    item("one", 0),
    item("", 0),
    item("three", 0),
  ]);
});

test("strips an empty trailing marker", () => {
  const input = "- one\n-";
  expect(parseMarkdownPaste(input)).toEqual([item("one", 0), item("", 0)]);
});

test("normalizeDepths flattens leading indent", () => {
  const items = parseMarkdownPaste("  - a\n  - b")!;
  expect(normalizeDepths(items)).toEqual([item("a", 0), item("b", 0)]);
});

test("normalizeDepths clamps skipped levels", () => {
  // depth jumps 0 -> 2 (skipping 1), should clamp to 1
  const items: ParsedItem[] = [
    item("a", 0),
    item("b", 2),
    item("c", 3),
  ];
  expect(normalizeDepths(items)).toEqual([
    item("a", 0),
    item("b", 1),
    item("c", 2),
  ]);
});
