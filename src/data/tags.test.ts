import { describe, expect, test } from "bun:test";

import {
  collectAllTags,
  collectTagCorpus,
  normalizeTag,
  parseTags,
  validateOutlineSearch,
} from "./tags";
import { buildTreeIndex, makeNode, type Node } from "./tree";

// The `?q=` query grammar (parse + build) moved to filter-query.ts (ADR 0047);
// its tests live in filter-query.test.ts. This file keeps the pure tag layer.

const index = (nodes: Node[]) => buildTreeIndex(nodes);

describe("normalizeTag", () => {
  test("strips the leading # and lowercases", () => {
    expect(normalizeTag("#Work-Q3")).toBe("work-q3");
    expect(normalizeTag("Work")).toBe("work");
    expect(normalizeTag("#важно")).toBe("важно");
  });
});

describe("collectAllTags", () => {
  const tree = index([
    makeNode({ id: "1", text: "#alpha #beta" }),
    makeNode({ id: "2", text: "#Alpha" }), // case variant of #alpha
    makeNode({ id: "3", text: "plain text, no tags" }),
  ]);

  test("distinct, sorted, case-folded dedupe keeping first-seen casing", () => {
    expect(collectAllTags(tree)).toEqual(["#alpha", "#beta"]);
  });

  test("excludeId drops one node’s contribution", () => {
    // dropping node 1 leaves only node 2's #Alpha (its own casing wins now)
    expect(collectAllTags(tree, "1")).toEqual(["#Alpha"]);
  });
});

describe("parseTags", () => {
  test("bails without a #, matches the regex path for tagged text", () => {
    expect(parseTags("plain text, no tags")).toEqual([]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags("#alpha #beta #alpha")).toEqual(["#alpha", "#beta"]);
  });
});

describe("tagCorpus (buildTreeIndex)", () => {
  test("matches collectAllTags for the same fixture (Plan 004 parity gate)", () => {
    const tree = index([
      makeNode({ id: "1", text: "#alpha #beta" }),
      makeNode({ id: "2", text: "#Alpha" }), // case variant of #alpha
      makeNode({ id: "3", text: "plain text, no tags" }),
      makeNode({ id: "4", text: "#gamma #gamma" }), // repeated tag, one node
    ]);
    expect(collectTagCorpus(tree.tagCorpus)).toEqual(collectAllTags(tree));
    expect(collectTagCorpus(tree.tagCorpus)).toEqual([
      "#alpha",
      "#beta",
      "#gamma",
    ]);
  });

  test("an empty tree has an empty corpus", () => {
    const tree = index([]);
    expect(collectTagCorpus(tree.tagCorpus)).toEqual([]);
  });

  test("counts occurrences, not just presence", () => {
    const tree = index([
      makeNode({ id: "1", text: "#work" }),
      makeNode({ id: "2", text: "#work #home" }),
    ]);
    expect(tree.tagCorpus.get("#work")?.count).toBe(2);
    expect(tree.tagCorpus.get("#home")?.count).toBe(1);
  });
});

describe("validateOutlineSearch", () => {
  test("keeps a trimmed string q, otherwise returns {}", () => {
    expect(validateOutlineSearch({ q: "#a" })).toEqual({ q: "#a" });
    expect(validateOutlineSearch({ q: "  #a  " })).toEqual({ q: "#a" });
    expect(validateOutlineSearch({ q: "   " })).toEqual({});
    expect(validateOutlineSearch({ q: 123 })).toEqual({});
    expect(validateOutlineSearch({})).toEqual({});
  });
});
