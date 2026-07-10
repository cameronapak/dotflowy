import { describe, expect, test } from "bun:test";

import {
  buildTagFilter,
  collectAllTags,
  collectTagCorpus,
  normalizeTag,
  parseQuery,
  parseTags,
  serializeQuery,
  validateOutlineSearch,
} from "./tags";
import { buildTreeIndex, makeNode, type Node } from "./tree";

const index = (nodes: Node[]) => buildTreeIndex(nodes);
const never = () => false;

describe("parseQuery", () => {
  test("returns [] for empty / missing input", () => {
    expect(parseQuery(undefined)).toEqual([]);
    expect(parseQuery("")).toEqual([]);
    expect(parseQuery("   ")).toEqual([]);
  });

  test("keeps only well-formed #tokens, distinct, in order", () => {
    expect(parseQuery("#a #b")).toEqual(["#a", "#b"]);
    expect(parseQuery("  #a   #b  ")).toEqual(["#a", "#b"]);
    expect(parseQuery("#a #a #b")).toEqual(["#a", "#b"]);
  });

  test("drops free text and a bare #", () => {
    expect(parseQuery("#a free text #b")).toEqual(["#a", "#b"]);
    expect(parseQuery("#")).toEqual([]);
  });
});

describe("serializeQuery", () => {
  test("round-trips parseQuery", () => {
    expect(serializeQuery(["#a", "#b"])).toBe("#a #b");
    expect(serializeQuery([])).toBe("");
    expect(parseQuery(serializeQuery(["#a", "#b"]))).toEqual(["#a", "#b"]);
  });
});

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

describe("buildTagFilter", () => {
  // r -> c -> g
  const r = makeNode({ id: "r", text: "root" });
  const c = makeNode({ id: "c", parentId: "r", text: "middle" });
  const g = makeNode({ id: "g", parentId: "c", text: "#x match" });
  const tree = index([r, c, g]);

  test("a match pulls in its ancestors up to (not including) rootId", () => {
    const f = buildTagFilter(tree, "r", ["#x"], never);
    expect(f.matchIds).toEqual(new Set(["g"]));
    // g matches; c is dimmed ancestor context; r (the root) is excluded
    expect(f.visibleIds).toEqual(new Set(["g", "c"]));
  });

  test("no active tags matches nothing", () => {
    const f = buildTagFilter(tree, "r", [], never);
    expect(f.matchIds.size).toBe(0);
    expect(f.visibleIds.size).toBe(0);
  });

  test("a hidden node takes its whole subtree with it", () => {
    const hideC = (n: Node) => n.id === "c";
    const f = buildTagFilter(tree, "r", ["#x"], hideC);
    // c is pruned, so its descendant g (the match) is never reached
    expect(f.matchIds.size).toBe(0);
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
