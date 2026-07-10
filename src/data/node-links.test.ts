import { describe, expect, test } from "bun:test";

import {
  flattenNodeText,
  linkTargetId,
  linkedNodeLabel,
  NODE_LINK_PATTERN,
  parseNodeLinks,
} from "./node-links";
import { buildTreeIndex, makeNode } from "./tree";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FALLBACK = "n_abc123_x9y8z7";

describe("NODE_LINK_PATTERN", () => {
  const re = new RegExp(`^(?:${NODE_LINK_PATTERN})$`, "u");

  test("matches a uuid token and the n_ fallback shape", () => {
    expect(re.test(`[[${A}]]`)).toBe(true);
    expect(re.test(`[[${FALLBACK}]]`)).toBe(true);
  });

  test("rejects hand-typed junk (stays literal text -- ADR 0032)", () => {
    expect(re.test("[[not an id]]")).toBe(false);
    expect(re.test("[[Project Phoenix]]")).toBe(false);
    expect(re.test("[[]]")).toBe(false);
    expect(re.test(`[${A}]`)).toBe(false);
  });
});

describe("parseNodeLinks", () => {
  test("returns unique targets in first-occurrence order", () => {
    expect(parseNodeLinks(`see [[${A}]] and [[${B}]] and [[${A}]]`)).toEqual([
      A,
      B,
    ]);
  });

  test("bails to the same empty array on link-free text", () => {
    expect(parseNodeLinks("plain bullet")).toBe(parseNodeLinks("another"));
    expect(parseNodeLinks("plain bullet")).toEqual([]);
  });

  test("ignores junk interiors", () => {
    expect(parseNodeLinks("[[not an id]]")).toEqual([]);
  });
});

describe("linkTargetId", () => {
  test("strips the brackets", () => {
    expect(linkTargetId(`[[${A}]]`)).toBe(A);
  });
});

describe("linkedNodeLabel", () => {
  test("flattens markup and reduces nested links to an ellipsis", () => {
    expect(linkedNodeLabel(`**bold** [x](https://x.dev) [[${A}]]`)).toBe(
      "bold x …",
    );
  });
});

describe("flattenNodeText", () => {
  const target = makeNode({ id: A, text: "Project **Phoenix**" });
  const referrer = makeNode({ id: B, text: `kickoff for [[${A}]] tomorrow` });
  const index = buildTreeIndex([target, referrer]);

  test("resolves a link to its target text, flattened", () => {
    expect(flattenNodeText(index, referrer.text)).toBe(
      "kickoff for Project Phoenix tomorrow",
    );
  });

  test('a missing target reads as "missing link"', () => {
    expect(
      flattenNodeText(
        index,
        `[[${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}]]`,
      ),
    ).toBe("missing link");
  });

  test("resolution is one level deep (no recursion through a chain)", () => {
    const chainEnd = makeNode({ id: FALLBACK, text: "the end" });
    const mid = makeNode({ id: A, text: `mid [[${FALLBACK}]]` });
    const idx = buildTreeIndex([chainEnd, mid]);
    expect(flattenNodeText(idx, `top [[${A}]]`)).toBe("top mid …");
  });
});

describe("buildTreeIndex linksByTarget", () => {
  test("buckets referrers under every target, deduped per referrer", () => {
    const target = makeNode({ id: A, text: "target" });
    const ref1 = makeNode({ id: B, text: `[[${A}]] twice [[${A}]]` });
    const ref2 = makeNode({ id: FALLBACK, text: `also [[${A}]]` });
    const index = buildTreeIndex([target, ref1, ref2]);
    expect(index.linksByTarget.get(A)).toEqual([B, FALLBACK]);
  });

  test("empty for a link-free outline", () => {
    const index = buildTreeIndex([makeNode({ id: A, text: "plain" })]);
    expect(index.linksByTarget.size).toBe(0);
  });
});
