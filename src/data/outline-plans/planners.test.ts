import { describe, expect, it } from "bun:test";

import {
  applyPlan,
  buildTreeIndex,
  chainDisagreements,
  childrenOf,
  makeOutlineNode,
  orderSiblings,
  planIndent,
  planInsertChildAtStart,
  planInsertSibling,
  planMoveNode,
  planOutdent,
  planRemoveNode,
  planSetBookmarkedAt,
  planSetCollapsed,
  planSetCompleted,
  planSetIsTask,
  planSetKind,
  planSetText,
  planSplitNode,
  type OutlineNode,
} from "./index";

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
    makeOutlineNode({
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

describe("sibling-chain invariant (ADR 0009) via outline-plans", () => {
  it("orderSiblings follows prevSiblingId chain", () => {
    const nodes = seedFlat(["a", "b", "c"]);
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

    {
      const index = buildTreeIndex(nodes);
      const plan = planIndent(index, "d", t++);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "b", "c"]);
    expect(assertChainOk(nodes, "b")).toEqual(["d"]);

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

    {
      const index = buildTreeIndex(nodes);
      const plan = planOutdent(index, "d", t++);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "e", "b", "d", "c"]);
    expect(assertChainOk(nodes, "b")).toEqual([]);

    {
      const index = buildTreeIndex(nodes);
      const plan = planRemoveNode(index, "e", t++);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }
    expect(assertChainOk(nodes, null)).toEqual(["a", "b", "d", "c"]);

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

describe("planInsertChildAtStart", () => {
  it("prepends under parent and repoints the old head", () => {
    let nodes = seedFlat(["p"]);
    let t = 10;
    {
      const index = buildTreeIndex(nodes);
      const plan = planInsertSibling(index, {
        id: "c1",
        userId: USER,
        parentId: "p",
        afterId: null,
        text: "c1",
        createdAt: t,
        updatedAt: t,
      });
      nodes = applyPlan(nodes, plan!);
      t += 1;
    }
    {
      const index = buildTreeIndex(nodes);
      const plan = planInsertChildAtStart(index, {
        id: "c0",
        userId: USER,
        parentId: "p",
        text: "c0",
        createdAt: t,
        updatedAt: t,
      });
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }
    expect(assertChainOk(nodes, "p")).toEqual(["c0", "c1"]);
    expect(nodes.find((n) => n.id === "c1")!.prevSiblingId).toBe("c0");
  });
});

describe("field planners (kind exclusivity)", () => {
  it("planSetIsTask clears kind", () => {
    let nodes = [
      makeOutlineNode({
        id: "a",
        userId: USER,
        kind: "paragraph",
        isTask: false,
        text: "a",
      }),
    ];
    const plan = planSetIsTask(buildTreeIndex(nodes), "a", true, 1);
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(nodes[0]!.isTask).toBe(true);
    expect(nodes[0]!.kind).toBeNull();
  });

  it("planSetKind clears isTask", () => {
    let nodes = [
      makeOutlineNode({
        id: "a",
        userId: USER,
        isTask: true,
        text: "a",
      }),
    ];
    const plan = planSetKind(buildTreeIndex(nodes), "a", "paragraph", 1);
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(nodes[0]!.kind).toBe("paragraph");
    expect(nodes[0]!.isTask).toBe(false);
  });

  it("planSetCompleted / collapsed / bookmarkedAt patch fields", () => {
    let nodes = seedFlat(["a"]);
    nodes = applyPlan(
      nodes,
      planSetCompleted(buildTreeIndex(nodes), "a", true, 1)!,
    );
    expect(nodes[0]!.completed).toBe(true);
    nodes = applyPlan(
      nodes,
      planSetCollapsed(buildTreeIndex(nodes), "a", true, 2)!,
    );
    expect(nodes[0]!.collapsed).toBe(true);
    nodes = applyPlan(
      nodes,
      planSetBookmarkedAt(buildTreeIndex(nodes), "a", 99, 3)!,
    );
    expect(nodes[0]!.bookmarkedAt).toBe(99);
  });
});

describe("planMoveNode", () => {
  it("swaps siblings (move up before previous)", () => {
    let nodes = seedFlat(["a", "b", "c"]);
    const plan = planMoveNode(buildTreeIndex(nodes), {
      id: "c",
      newParentId: null,
      afterSiblingId: "a",
      updatedAt: 1,
    });
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, null)).toEqual(["a", "c", "b"]);
  });

  it("reparents as first child and can expand destination", () => {
    let nodes = seedFlat(["a", "b"]);
    nodes = nodes.map((n) => (n.id === "a" ? { ...n, collapsed: true } : n));
    {
      const plan = planInsertSibling(buildTreeIndex(nodes), {
        id: "a1",
        userId: USER,
        parentId: "a",
        afterId: null,
        text: "a1",
        createdAt: 1,
        updatedAt: 1,
      });
      nodes = applyPlan(nodes, plan!);
    }
    const plan = planMoveNode(buildTreeIndex(nodes), {
      id: "b",
      newParentId: "a",
      afterSiblingId: null,
      updatedAt: 2,
      expandIds: ["a"],
    });
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, null)).toEqual(["a"]);
    expect(assertChainOk(nodes, "a")).toEqual(["b", "a1"]);
    expect(nodes.find((n) => n.id === "a")!.collapsed).toBe(false);
  });

  it("no-ops when already at destination without expands", () => {
    const nodes = seedFlat(["a", "b"]);
    const plan = planMoveNode(buildTreeIndex(nodes), {
      id: "b",
      newParentId: null,
      afterSiblingId: "a",
      updatedAt: 1,
    });
    expect(plan).toBeNull();
  });
});

describe("planSplitNode", () => {
  it("patches left text and inserts right sibling atomically", () => {
    let nodes = seedFlat(["a", "b"]);
    nodes = nodes.map((n) => (n.id === "a" ? { ...n, text: "alphabravo" } : n));
    const plan = planSplitNode(buildTreeIndex(nodes), {
      id: "a",
      newId: "a2",
      userId: USER,
      parentId: null,
      afterId: "a",
      leftText: "alpha",
      rightText: "bravo",
      createdAt: 5,
      updatedAt: 5,
    });
    expect(plan).not.toBeNull();
    expect(plan!.inserts).toHaveLength(1);
    expect(
      plan!.patches.some((p) => p.id === "a" && p.fields.text === "alpha"),
    ).toBe(true);
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, null)).toEqual(["a", "a2", "b"]);
    expect(nodes.find((n) => n.id === "a")!.text).toBe("alpha");
    expect(nodes.find((n) => n.id === "a2")!.text).toBe("bravo");
    expect(nodes.find((n) => n.id === "b")!.prevSiblingId).toBe("a2");
  });
});
