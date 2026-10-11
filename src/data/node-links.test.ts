import { describe, expect, test } from "bun:test";

import {
  flattenNodeText,
  linkTargetId,
  linkedNodeLabel,
  NODE_LINK_PATTERN,
  parseNodeLinks,
} from "./node-links";
import { buildTreeIndex, createNode } from "./tree";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FALLBACK = "n_abc123_x9y8z7";

test.each([
  [`[[${A}]]`, true],
  [`[[${FALLBACK}]]`, true],
  // Hand-typed junk stays literal text (ADR 0032).
  ["[[not an id]]", false],
  ["[[Project Phoenix]]", false],
  ["[[]]", false],
  [`[${A}]`, false],
])("NODE_LINK_PATTERN on %p -> %p", (text, expected) => {
  expect(new RegExp(`^(?:${NODE_LINK_PATTERN})$`, "u").test(text)).toBe(
    expected,
  );
});

test("parseNodeLinks returns unique targets in first-occurrence order, ignoring junk", () => {
  expect(parseNodeLinks(`see [[${A}]] and [[${B}]] and [[${A}]]`)).toEqual([
    A,
    B,
  ]);
  expect(parseNodeLinks("[[not an id]]")).toEqual([]);
  // Link-free text bails to one shared empty array.
  expect(parseNodeLinks("plain bullet")).toEqual([]);
  expect(parseNodeLinks("plain bullet")).toBe(parseNodeLinks("another"));
});

test("linkTargetId strips the brackets", () => {
  expect(linkTargetId(`[[${A}]]`)).toBe(A);
});

test("linkedNodeLabel flattens markup and reduces nested links to an ellipsis", () => {
  expect(linkedNodeLabel(`**bold** [x](https://x.dev) [[${A}]]`)).toBe(
    "bold x …",
  );
});

describe("flattenNodeText", () => {
  test("resolves a link to its target text, flattened, or reads a missing target as missing", () => {
    const target = createNode({ id: A, text: "Project **Phoenix**" });
    const referrer = createNode({
      id: B,
      text: `kickoff for [[${A}]] tomorrow`,
    });
    const index = buildTreeIndex([target, referrer]);
    expect(flattenNodeText(index, referrer.text)).toBe(
      "kickoff for Project Phoenix tomorrow",
    );
    expect(
      flattenNodeText(index, "[[00000000-0000-0000-0000-000000000000]]"),
    ).toBe("missing link");
  });

  test("resolution is one level deep (no recursion through a chain)", () => {
    const chainEnd = createNode({ id: FALLBACK, text: "the end" });
    const mid = createNode({ id: A, text: `mid [[${FALLBACK}]]` });
    const idx = buildTreeIndex([chainEnd, mid]);
    expect(flattenNodeText(idx, `top [[${A}]]`)).toBe("top mid …");
  });
});

test("buildTreeIndex linksByTarget buckets referrers per target, deduped per referrer", () => {
  expect(
    buildTreeIndex([createNode({ id: A, text: "plain" })]).linksByTarget.size,
  ).toBe(0);
  const target = createNode({ id: A, text: "target" });
  const ref1 = createNode({ id: B, text: `[[${A}]] twice [[${A}]]` });
  const ref2 = createNode({ id: FALLBACK, text: `also [[${A}]]` });
  const index = buildTreeIndex([target, ref1, ref2]);
  expect(index.linksByTarget.get(A)).toEqual([B, FALLBACK]);
});
