import { expect, test } from "bun:test";
import { Effect } from "effect";

import {
  blockComponentPattern,
  inlineComponentPattern,
  parseBlockComponent,
  parseInlineComponent,
  trailingTone,
} from "./comark";
import { flattenInline } from "./inline-text";
import { outlineToMarkdown } from "./markdown";
import { exportOpml } from "./opml-export";
import { parseOpml } from "./opml-import";
import { buildTreeIndex, createNode } from "./tree";

const matches = (pattern: string, text: string) =>
  [...text.matchAll(new RegExp(pattern, "gu"))].map((m) => m[0]);

test("inline components match only installed names with a label", () => {
  const pattern = inlineComponentPattern(["status"]);
  expect(
    matches(pattern, 'Trip is :status[Booked]{tone="green"} and :status[x]'),
  ).toEqual([':status[Booked]{tone="green"}', ":status[x]"]);
  // Prose that looks like syntax stays text: no label, an unknown name, a
  // colon inside a word or time, and a reserved built-in name.
  for (const prose of [
    "Note:status[Booked] is glued to a word",
    "Meet at 10:30[am]",
    "a bare :status mention",
    ":weather[Sunny] is not installed",
    "Read :verse[John 3:16]",
  ])
    expect(matches(pattern, prose)).toEqual([]);
  expect(matches(inlineComponentPattern([]), ":status[Booked]")).toEqual([]);
});

test("block components match by exact name at the start of a bullet", () => {
  const pattern = blockComponentPattern(["board"]);
  expect(matches(pattern, "::board Sermon series")).toEqual(["::board"]);
  expect(matches(pattern, '::board{tone="blue"} Plan')).toEqual([
    '::board{tone="blue"}',
  ]);
  expect(matches(pattern, "::board-x Plan")).toEqual([]);
  expect(matches(pattern, "Plan ::board")).toEqual([]);
  expect(parseBlockComponent('::board{tone="blue"} Plan')).toMatchObject({
    name: "board",
    title: "Plan",
  });
  expect(parseBlockComponent("::boards Plan")?.name).toBe("boards");
});

test("parsers read labels, attributes, and trailing tones", () => {
  const chip = parseInlineComponent(':status[Booked]{tone="green" x}');
  expect(chip?.label).toBe("Booked");
  expect(chip?.attrs.get("tone")).toBe("green");
  expect(chip?.attrs.get("x")).toBe(true);
  expect(parseInlineComponent(":status")).toBeNull();
  expect(trailingTone('Doing {tone="yellow"}')).toEqual({
    label: "Doing",
    tone: "yellow",
  });
  expect(trailingTone('Doing {tone="pink"}')).toEqual({
    label: 'Doing {tone="pink"}',
    tone: null,
  });
});

test("component source is stored, flattened, and exported verbatim", () => {
  const text = 'Retreat :status[Booked]{tone="green"} ::not-a-block';
  expect(flattenInline(text)).toBe(text);
  const index = buildTreeIndex([
    createNode({ id: "a", text: "::board Sermon series" }),
    createNode({ id: "b", parentId: "a", text: 'Ideas {tone="blue"}' }),
    createNode({ id: "c", prevSiblingId: "a", text }),
  ]);
  const markdown = outlineToMarkdown(index, ["a", "c"]);
  expect(markdown).toContain("::board Sermon series");
  expect(markdown).toContain('Ideas {tone="blue"}');
  expect(markdown).toContain(text);
  // OPML round-trips the source unchanged.
  const forest = Effect.runSync(
    parseOpml(exportOpml(index, null, { title: "t" })),
  ).forest;
  expect(forest.map((n) => n.text)).toEqual(["::board Sermon series", text]);
  expect(forest[0]?.children.map((n) => n.text)).toEqual([
    'Ideas {tone="blue"}',
  ]);
});
