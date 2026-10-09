import { expect, test } from "bun:test";

import { siblingChainRepairs } from "./collection";
import { createNode, type Node } from "./tree";

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

test("siblingChainRepairs: clean chains yield zero fixes", () => {
  expect(
    siblingChainRepairs([
      createNode({ id: "a", prevSiblingId: null }),
      createNode({ id: "b", prevSiblingId: "a" }),
      createNode({ id: "c", prevSiblingId: "b" }),
    ]),
  ).toEqual([]);
  expect(siblingChainRepairs([createNode({ id: "solo" })])).toEqual([]);
});

test.each<[string, Node[]]>([
  [
    "a fan (two siblings sharing one prevSiblingId)",
    [
      createNode({ id: "a", parentId: "p", prevSiblingId: null }),
      createNode({ id: "b", parentId: "p", prevSiblingId: null }),
      createNode({ id: "p" }),
    ],
  ],
  [
    "a dangle (pointer to a non-sibling)",
    [
      createNode({ id: "p" }),
      createNode({ id: "x", parentId: "p", prevSiblingId: null }),
      createNode({ id: "y", parentId: "p", prevSiblingId: "ghost" }),
    ],
  ],
])("siblingChainRepairs: %s is detected and converges", (_name, nodes) => {
  const fixes = siblingChainRepairs(nodes);
  expect(fixes.length).toBeGreaterThan(0);
  // applying the repairs makes the chain consistent -> second pass is clean
  expect(siblingChainRepairs(applyFixes(nodes, fixes))).toEqual([]);
});

test("siblingChainRepairs: only the corrupt parent gets fixes", () => {
  const fixes = siblingChainRepairs([
    createNode({ id: "P1", prevSiblingId: null }),
    createNode({ id: "P2", prevSiblingId: "P1" }),
    // P1: clean
    createNode({ id: "c1", parentId: "P1", prevSiblingId: null }),
    createNode({ id: "c2", parentId: "P1", prevSiblingId: "c1" }),
    // P2: a fan
    createNode({ id: "d1", parentId: "P2", prevSiblingId: null }),
    createNode({ id: "d2", parentId: "P2", prevSiblingId: null }),
  ]);
  expect(fixes.length).toBeGreaterThan(0);
  expect(fixes.every((f) => f.id === "d1" || f.id === "d2")).toBe(true);
});
