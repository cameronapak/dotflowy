import { describe, expect, test } from "bun:test";

import { siblingChainRepairs } from "./collection";
import { makeNode, type Node } from "./tree";

/** Apply a repair set to a node list (what healSiblingChains does to the store). */
function applyFixes(
  nodes: Node[],
  fixes: Array<{ id: string; prevSiblingId: string | null }>,
): Node[] {
  const m = new Map(fixes.map((f) => [f.id, f.prevSiblingId]));
  return nodes.map((n) =>
    m.has(n.id) ? { ...n, prevSiblingId: m.get(n.id) ?? null } : n,
  );
}

describe("siblingChainRepairs", () => {
  test("clean data yields zero fixes (idempotent no-op)", () => {
    const nodes = [
      makeNode({ id: "a", prevSiblingId: null }),
      makeNode({ id: "b", prevSiblingId: "a" }),
      makeNode({ id: "c", prevSiblingId: "b" }),
    ];
    expect(siblingChainRepairs(nodes)).toEqual([]);
  });

  test("a single child is trivially clean", () => {
    expect(siblingChainRepairs([makeNode({ id: "solo" })])).toEqual([]);
  });

  test("a fan (two siblings sharing one prevSiblingId) is detected and converges", () => {
    // both claim head -> one gets orphan-appended by buildTreeIndex
    const nodes = [
      makeNode({ id: "a", parentId: "p", prevSiblingId: null }),
      makeNode({ id: "b", parentId: "p", prevSiblingId: null }),
      makeNode({ id: "p" }),
    ];
    const fixes = siblingChainRepairs(nodes);
    expect(fixes.length).toBeGreaterThan(0);
    // applying the repairs makes the chain consistent -> second pass is clean
    expect(siblingChainRepairs(applyFixes(nodes, fixes))).toEqual([]);
  });

  test("a dangle (pointer to a non-sibling) is detected and converges", () => {
    const nodes = [
      makeNode({ id: "p" }),
      makeNode({ id: "x", parentId: "p", prevSiblingId: null }),
      makeNode({ id: "y", parentId: "p", prevSiblingId: "ghost" }),
    ];
    const fixes = siblingChainRepairs(nodes);
    expect(fixes.length).toBeGreaterThan(0);
    expect(siblingChainRepairs(applyFixes(nodes, fixes))).toEqual([]);
  });

  test("only the corrupt parent gets fixes; a clean sibling group is untouched", () => {
    const nodes = [
      makeNode({ id: "P1", prevSiblingId: null }),
      makeNode({ id: "P2", prevSiblingId: "P1" }),
      // P1: clean
      makeNode({ id: "c1", parentId: "P1", prevSiblingId: null }),
      makeNode({ id: "c2", parentId: "P1", prevSiblingId: "c1" }),
      // P2: a fan
      makeNode({ id: "d1", parentId: "P2", prevSiblingId: null }),
      makeNode({ id: "d2", parentId: "P2", prevSiblingId: null }),
    ];
    const fixes = siblingChainRepairs(nodes);
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.every((f) => f.id === "d1" || f.id === "d2")).toBe(true);
  });
});
