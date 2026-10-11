import { describe, expect, test } from "bun:test";

import {
  buildTrail,
  buildTreeIndex,
  childrenOf,
  countSubtreeNodes,
  createNode,
  isNodeInheritedLocked,
  isNodeLocked,
  orphanedMirrorsBy,
  planRemoveSubtrees,
  subtreeContainsLocked,
  trueSourceOf,
  wouldMirrorCycle,
} from "./tree";

test("buildTreeIndex groups children by parentId in sibling-chain order", () => {
  const p = createNode({ id: "p" });
  const k1 = createNode({ id: "k1", parentId: "p", prevSiblingId: null });
  const k2 = createNode({ id: "k2", parentId: "p", prevSiblingId: "k1" });
  const index = buildTreeIndex([k2, p, k1]); // fed out of order

  expect(childrenOf(index, "p").map((n) => n.id)).toEqual(["k1", "k2"]);
  expect(childrenOf(index, null).map((n) => n.id)).toEqual(["p"]);
  expect(childrenOf(index, "nope")).toEqual([]);
});

test("buildTreeIndex buckets every mirror under its source id (ADR 0022)", () => {
  expect(
    buildTreeIndex([createNode({ id: "a" }), createNode({ id: "b" })])
      .mirrorsBySource.size,
  ).toBe(0);

  const index = buildTreeIndex([
    createNode({ id: "src" }),
    createNode({ id: "m1", mirrorOf: "src" }),
    createNode({ id: "m2", mirrorOf: "src" }),
    createNode({ id: "other" }),
    // a mirror whose source is absent still indexes (broken-mirror tolerant)
    createNode({ id: "m3", mirrorOf: "ghost" }),
  ]);
  expect(index.mirrorsBySource.get("src")).toEqual(["m1", "m2"]);
  expect(index.mirrorsBySource.get("ghost")).toEqual(["m3"]);
  // A source is not its own mirror; an un-mirrored node has no bucket.
  expect(index.mirrorsBySource.has("other")).toBe(false);
  expect(index.mirrorsBySource.has("m1")).toBe(false);
});

describe("effective locks (ADR 0067)", () => {
  test("inherit recursively and preserve a nested direct lock", () => {
    const index = buildTreeIndex([
      createNode({ id: "root", locked: true }),
      createNode({ id: "child", parentId: "root" }),
      createNode({ id: "grandchild", parentId: "child", locked: true }),
    ]);

    expect(isNodeLocked(index, "child")).toBe(true);
    expect(isNodeLocked(index, "grandchild")).toBe(true);
    expect(isNodeInheritedLocked(index, "root")).toBe(false);
    expect(isNodeInheritedLocked(index, "grandchild")).toBe(true);
    expect(subtreeContainsLocked(index, ["root"])).toBe(true);
  });

  test("crosses from a locked ancestor through a mirror to source content", () => {
    const index = buildTreeIndex([
      createNode({ id: "locked", locked: true }),
      createNode({ id: "mirror", parentId: "locked", mirrorOf: "source" }),
      createNode({ id: "source" }),
      createNode({ id: "source-child", parentId: "source" }),
    ]);

    expect(isNodeLocked(index, "mirror")).toBe(true);
    expect(isNodeLocked(index, "source")).toBe(true);
    expect(isNodeLocked(index, "source-child")).toBe(true);
  });
});

describe("orphanedMirrorsBy (delete-source guard, ADR 0022)", () => {
  // src has two children; M (under p) mirrors src.
  const tree = () => [
    createNode({ id: "src" }),
    createNode({ id: "k1", parentId: "src", prevSiblingId: null }),
    createNode({ id: "k2", parentId: "src", prevSiblingId: "k1" }),
    createNode({ id: "p", prevSiblingId: "src" }),
    createNode({
      id: "M",
      parentId: "p",
      prevSiblingId: null,
      mirrorOf: "src",
    }),
  ];

  test("deleting a source with a live mirror reports the orphan", () => {
    const index = buildTreeIndex(tree());
    expect(orphanedMirrorsBy(index, ["src"])).toEqual(["M"]);
  });

  test("deleting a plain mirror is always safe", () => {
    const index = buildTreeIndex(tree());
    expect(orphanedMirrorsBy(index, ["M"])).toEqual([]);
  });

  test("a source is found even when it sits inside the deleted subtree", () => {
    // Delete p's parent; src is a deep descendant whose mirror lives elsewhere.
    const nested = [
      createNode({ id: "top" }),
      createNode({ id: "src", parentId: "top", prevSiblingId: null }),
      createNode({ id: "p", prevSiblingId: "top" }),
      createNode({
        id: "M",
        parentId: "p",
        prevSiblingId: null,
        mirrorOf: "src",
      }),
    ];
    const index = buildTreeIndex(nested);
    expect(orphanedMirrorsBy(index, ["top"])).toEqual(["M"]);
  });

  test("deleting a source together with all its mirrors is safe", () => {
    // Both src and its only mirror M sit under `top`, so deleting top takes both.
    const together = [
      createNode({ id: "top" }),
      createNode({ id: "src", parentId: "top", prevSiblingId: null }),
      createNode({
        id: "M",
        parentId: "top",
        prevSiblingId: "src",
        mirrorOf: "src",
      }),
    ];
    const index = buildTreeIndex(together);
    expect(orphanedMirrorsBy(index, ["top"])).toEqual([]);
  });

  test("a mirror-free deletion is always safe", () => {
    const index = buildTreeIndex([
      createNode({ id: "a" }),
      createNode({ id: "b", parentId: "a", prevSiblingId: null }),
    ]);
    expect(orphanedMirrorsBy(index, ["a"])).toEqual([]);
  });
});

test("trueSourceOf resolves a mirror to its source, anything else to itself", () => {
  const index = buildTreeIndex([
    createNode({ id: "src" }),
    createNode({ id: "m", mirrorOf: "src" }),
    createNode({ id: "plain" }),
  ]);
  // mirrorOf always points at a TRUE source, so one hop flattens.
  expect(trueSourceOf(index, "m")).toBe("src");
  expect(trueSourceOf(index, "plain")).toBe("plain");
  expect(trueSourceOf(index, "src")).toBe("src");
  expect(trueSourceOf(index, "ghost")).toBe("ghost");
});

// src > c > gc ; `other` is an unrelated top-level node.
const cycleIndex = buildTreeIndex([
  createNode({ id: "src", parentId: null }),
  createNode({ id: "c", parentId: "src" }),
  createNode({ id: "gc", parentId: "c" }),
  createNode({ id: "other", parentId: null, prevSiblingId: "src" }),
]);
test.each<[string, string, string | null, boolean]>([
  ["into an unrelated branch is fine", "src", "other", false],
  ["into the source itself cycles", "src", "src", true],
  ["into a direct child of the source cycles", "src", "c", true],
  ["into a deep descendant of the source cycles", "src", "gc", true],
  // A mirror of c under src windows c's subtree, which never contains it.
  ["a descendant under the source does NOT cycle", "c", "src", false],
  ["into Home (null parent) never cycles", "src", null, false],
])("wouldMirrorCycle: mirroring %s", (_name, source, parent, expected) => {
  expect(wouldMirrorCycle(cycleIndex, source, parent)).toBe(expected);
});

test("buildTrail walks ancestors top-down, including rootId itself", () => {
  const index = buildTreeIndex([
    createNode({ id: "a", parentId: null }),
    createNode({ id: "b", parentId: "a" }),
    createNode({ id: "c", parentId: "b" }),
  ]);
  expect(buildTrail(index, "c").map((n) => n.id)).toEqual(["a", "b", "c"]);
  expect(buildTrail(index, "a").map((n) => n.id)).toEqual(["a"]);
  expect(buildTrail(index, null)).toEqual([]);
});

describe("countSubtreeNodes + planRemoveSubtrees", () => {
  // top-level: x -> p -> y ; p's children a -> b -> c ; b's children b1 -> b2
  const fixture = () =>
    buildTreeIndex([
      createNode({ id: "x", prevSiblingId: null }),
      createNode({ id: "p", prevSiblingId: "x" }),
      createNode({ id: "y", prevSiblingId: "p" }),
      createNode({ id: "a", parentId: "p", prevSiblingId: null }),
      createNode({ id: "b", parentId: "p", prevSiblingId: "a" }),
      createNode({ id: "c", parentId: "p", prevSiblingId: "b" }),
      createNode({ id: "b1", parentId: "b", prevSiblingId: null }),
      createNode({ id: "b2", parentId: "b", prevSiblingId: "b1" }),
    ]);

  test("counts roots + all descendants, deduping overlapping roots", () => {
    const index = fixture();
    expect(countSubtreeNodes(index, ["p"])).toBe(6);
    expect(countSubtreeNodes(index, ["b"])).toBe(3);
    // b sits inside p's subtree -- counted once
    expect(countSubtreeNodes(index, ["p", "b"])).toBe(6);
    expect(countSubtreeNodes(index, ["ghost"])).toBe(0);
  });

  test("single root: deletes children-before-parent, repoints the follower", () => {
    const index = fixture();
    const plan = planRemoveSubtrees(index, ["p"]);
    expect(plan.deleteIds).toHaveLength(6);
    // reverse pre-order: the root is deleted LAST, every child before its parent
    expect(plan.deleteIds[plan.deleteIds.length - 1]).toBe("p");
    expect(plan.deleteIds.indexOf("b1")).toBeLessThan(
      plan.deleteIds.indexOf("b"),
    );
    expect(plan.deleteIds.indexOf("b2")).toBeLessThan(
      plan.deleteIds.indexOf("b"),
    );
    // y followed p -> repointed to p's prev (x)
    expect(plan.repoints).toEqual([{ id: "y", prevSiblingId: "x" }]);
  });

  test("contiguous run: the survivor walks the whole doomed chain to its head", () => {
    const index = fixture();
    const plan = planRemoveSubtrees(index, ["a", "b"]);
    expect(plan.deleteIds).toHaveLength(4);
    // c followed b; a and b are both doomed -> c becomes the head (null prev)
    expect(plan.repoints).toEqual([{ id: "c", prevSiblingId: null }]);
  });

  test("tail root needs no repoint; unknown ids are skipped", () => {
    const index = fixture();
    const plan = planRemoveSubtrees(index, ["y", "ghost"]);
    expect(plan.deleteIds).toEqual(["y"]);
    expect(plan.repoints).toEqual([]);
  });
});
