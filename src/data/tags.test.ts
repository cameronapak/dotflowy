import { expect, test } from "bun:test";

import {
  collectAllTags,
  collectTagCorpus,
  normalizeTag,
  parseTags,
  validateOutlineSearch,
} from "./tags";
import { buildTreeIndex, createNode, type Node } from "./tree";

// The `?q=` query grammar (parse + build) moved to filter-query.ts (ADR 0047);
// its tests live in filter-query.test.ts. This file keeps the pure tag layer.

const index = (nodes: Node[]) => buildTreeIndex(nodes);

test("normalizeTag strips the leading # and lowercases", () => {
  expect(normalizeTag("#Work-Q3")).toBe("work-q3");
  expect(normalizeTag("Work")).toBe("work");
  expect(normalizeTag("#важно")).toBe("важно");
});

test("collectAllTags deduplicates and sorts case-insensitively, excluding a node's contribution", () => {
  const tree = index([
    createNode({ id: "1", text: "#alpha #beta" }),
    createNode({ id: "2", text: "#Alpha" }), // case variant of #alpha
    createNode({ id: "3", text: "plain text, no tags" }),
  ]);

  expect(collectAllTags(tree)).toEqual(["#alpha", "#beta"]);
  // dropping node 1 leaves only node 2's #Alpha (its own casing wins now)
  expect(collectAllTags(tree, "1")).toEqual(["#Alpha"]);
});

test("parseTags bails without a # and deduplicates tagged text", () => {
  expect(parseTags("plain text, no tags")).toEqual([]);
  expect(parseTags("")).toEqual([]);
  expect(parseTags("#alpha #beta #alpha")).toEqual(["#alpha", "#beta"]);
});

test("tagCorpus collects distinct case-folded tags, counting tagged nodes", () => {
  const tree = index([
    createNode({ id: "1", text: "#alpha #beta" }),
    createNode({ id: "2", text: "#Alpha" }), // case variant of #alpha
    createNode({ id: "3", text: "plain text, no tags" }),
    createNode({ id: "4", text: "#gamma #gamma" }), // repeated tag, one node
  ]);
  expect(collectTagCorpus(tree.tagCorpus)).toEqual([
    "#alpha",
    "#beta",
    "#gamma",
  ]);
  // Counts tagged nodes, not just presence.
  expect(tree.tagCorpus.get("#alpha")?.count).toBe(2);
  expect(tree.tagCorpus.get("#beta")?.count).toBe(1);
  expect(tree.tagCorpus.get("#gamma")?.count).toBe(1);
  expect(collectTagCorpus(index([]).tagCorpus)).toEqual([]);
});

test("validateOutlineSearch keeps a trimmed string q, otherwise returns {}", () => {
  expect(validateOutlineSearch({ q: "#a" })).toEqual({ q: "#a" });
  expect(validateOutlineSearch({ q: "  #a  " })).toEqual({ q: "#a" });
  expect(validateOutlineSearch({ q: "   " })).toEqual({});
  expect(validateOutlineSearch({ q: 123 })).toEqual({});
  expect(validateOutlineSearch({})).toEqual({});
});
