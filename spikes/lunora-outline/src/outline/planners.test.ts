import { describe, expect, it } from "vitest";

import {
  applyPlan,
  buildTreeIndex,
  chainDisagreements,
  childrenOf,
  makeNode,
  orderSiblings,
  planIndent,
  planInsertSibling,
  planOutdent,
  planRemoveNode,
  planSetText,
  type OutlineNode,
} from "./index.js";

const USER = "user-1";

function assertChainOk(nodes: OutlineNode[], parentId: string | null) {
  const index = buildTreeIndex(nodes);
  const kids = childrenOf(index, parentId);
  const ordered = orderSiblings(kids);
  expect(chainDisagreements(ordered)).toEqual([]);
  return ordered.map((n) => n.id);
}

function seedFlat(ids: string[]): OutlineNode[] {
  return ids.map((id, i) =>
    makeNode({
      id,
      userId: USER,
      parentId: null,
      prevSiblingId: i === 0 ? null : ids[i - 1]!,
      text: id,
      createdAt: i,
      updatedAt: i,
    }),
  );
}

describe("sibling-chain invariant (ADR 0009)", () => {
  it("orderSiblings follows prevSiblingId chain", () => {
    const nodes = seedFlat(["a", "b", "c"]);
    // Scramble arrival order — chain still recovers.
    const scrambled = [nodes[2]!, nodes[0]!, nodes[1]!];
    expect(orderSiblings(scrambled).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("chainDisagreements empty for a valid chain", () => {
    const nodes = seedFlat(["a", "b", "c"]);
    expect(chainDisagreements(orderSiblings(nodes))).toEqual([]);
  });

  it("rapid structural sequences leave chain intact", () => {
    let nodes = seedFlat(["a", "b", "c"]);
    let t = 100;

    // Insert d after b → a, b, d, c
    {
      const index = buildTreeIndex(nodes);
      const plan = planInsertSibling(index, {
        id: "d",
        userId: USER,
        parentId: null,
        afterId: "b",
        text: "d",
        createdAt: t,
        updatedAt: t,
      });
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
      t += 1;
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "b", "d", "c"]);

    // Indent d under b → a, b(d), c
    {
      const index = buildTreeIndex(nodes);
      const plan = planIndent(index, "d", t++);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "b", "c"]);
    expect(assertChainOk(nodes, "b")).toEqual(["d"]);

    // Insert e after a → a, e, b(d), c
    {
      const index = buildTreeIndex(nodes);
      const plan = planInsertSibling(index, {
        id: "e",
        userId: USER,
        parentId: null,
        afterId: "a",
        text: "e",
        createdAt: t,
        updatedAt: t,
      });
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
      t += 1;
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "e", "b", "c"]);

    // Outdent d → a, e, b, d, c
    {
      const index = buildTreeIndex(nodes);
      const plan = planOutdent(index, "d", t++);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "e", "b", "d", "c"]);
    expect(assertChainOk(nodes, "b")).toEqual([]);

    // Remove e (cascade) → a, b, d, c
    {
      const index = buildTreeIndex(nodes);
      const plan = planRemoveNode(index, "e", t++);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "b", "d", "c"]);

    // Insert nested child under b, then remove b (cascade deletes child)
    {
      const index = buildTreeIndex(nodes);
      const plan = planInsertSibling(index, {
        id: "b1",
        userId: USER,
        parentId: "b",
        afterId: null,
        text: "b1",
        createdAt: t,
        updatedAt: t,
      });
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
      t += 1;
    }
    expect(assertChainOk(nodes, "b")).toEqual(["b1"]);

    {
      const index = buildTreeIndex(nodes);
      const plan = planRemoveNode(index, "b", t++);
      expect(plan).not.toBeNull();
      expect(plan!.deletes.sort()).toEqual(["b", "b1"].sort());
      nodes = applyPlan(nodes, plan!);
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "d", "c"]);
    expect(nodes.find((n) => n.id === "b1")).toBeUndefined();

    // setText is field-only — chain untouched
    {
      const index = buildTreeIndex(nodes);
      const plan = planSetText(index, "a", "alpha", t++);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "d", "c"]);
    expect(nodes.find((n) => n.id === "a")!.text).toBe("alpha");
  });

  it("burst of mid-list inserts preserves totality", () => {
    let nodes = seedFlat(["root"]);
    let afterId: string | null = "root";
    let t = 1;

    for (let i = 0; i < 20; i++) {
      const id = `n${i}`;
      const index = buildTreeIndex(nodes);
      const plan = planInsertSibling(index, {
        id,
        userId: USER,
        parentId: null,
        afterId,
        text: id,
        createdAt: t,
        updatedAt: t,
      });
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
      afterId = id;
      t += 1;
    }

    const ordered = assertChainOk(nodes, null);
    expect(ordered).toEqual([
      "root",
      ...Array.from({ length: 20 }, (_, i) => `n${i}`),
    ]);
  });
});
