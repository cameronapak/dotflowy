import { describe, expect, it } from "bun:test";

import {
  applyPlan,
  buildTreeIndex,
  chainDisagreements,
  childrenOf,
  makeOutlineNode,
  orderSiblings,
  planIndent,
  planAppendChild,
  planImportNodes,
  planInsertChildAtStart,
  planInsertSibling,
  planIndentMany,
  planMaterializeDailyNodes,
  planMirrorNode,
  planMoveMany,
  planMoveNode,
  planOutdent,
  planOutdentMany,
  planRemoveMany,
  planRemoveNode,
  planRestoreNodes,
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

describe("planAppendChild", () => {
  it("appends after the current last sibling", () => {
    let nodes = seedFlat(["a", "b"]);
    const plan = planAppendChild(buildTreeIndex(nodes), {
      id: "c",
      userId: USER,
      parentId: null,
      text: "c",
      createdAt: 10,
      updatedAt: 10,
    });
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, null)).toEqual(["a", "b", "c"]);
    expect(nodes.find((n) => n.id === "c")!.prevSiblingId).toBe("b");
  });

  it("inserts as sole child when parent is empty", () => {
    let nodes = seedFlat(["p"]);
    const plan = planAppendChild(buildTreeIndex(nodes), {
      id: "c",
      userId: USER,
      parentId: "p",
      text: "c",
      createdAt: 10,
      updatedAt: 10,
    });
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, "p")).toEqual(["c"]);
  });
});

describe("planImportNodes", () => {
  it("is insert-only with no patches", () => {
    const batch = [
      makeOutlineNode({
        id: "x",
        userId: USER,
        parentId: null,
        prevSiblingId: null,
        text: "x",
      }),
      makeOutlineNode({
        id: "y",
        userId: USER,
        parentId: null,
        prevSiblingId: "x",
        text: "y",
      }),
    ];
    const plan = planImportNodes(batch);
    expect(plan.deletes).toEqual([]);
    expect(plan.patches).toEqual([]);
    expect(plan.inserts.map((n) => n.id)).toEqual(["x", "y"]);
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

describe("planRestoreNodes", () => {
  it("deletes added, inserts removed, patches changed", () => {
    const current = seedFlat(["a", "b", "c"]);
    const target = seedFlat(["a", "b"]).map((n) =>
      n.id === "a" ? { ...n, text: "alpha" } : n,
    );
    target.push(
      makeOutlineNode({
        id: "d",
        userId: USER,
        parentId: null,
        prevSiblingId: "b",
        text: "d",
        createdAt: 9,
        updatedAt: 9,
      }),
    );
    const plan = planRestoreNodes(current, target);
    expect(plan.deletes).toEqual(["c"]);
    expect(plan.inserts.map((n) => n.id)).toEqual(["d"]);
    expect(plan.patches).toEqual([
      expect.objectContaining({
        id: "a",
        fields: expect.objectContaining({ text: "alpha" }),
      }),
    ]);
    const next = applyPlan(current, plan);
    expect(assertChainOk(next, null)).toEqual(["a", "b", "d"]);
    expect(next.find((n) => n.id === "a")!.text).toBe("alpha");
  });

  it("no-ops when current already matches target", () => {
    const nodes = seedFlat(["a", "b"]);
    const plan = planRestoreNodes(
      nodes,
      nodes.map((n) => ({ ...n })),
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(plan.patches).toEqual([]);
  });
});

describe("planMirrorNode", () => {
  it("appends a flattened mirror as last child", () => {
    let nodes = seedFlat(["src", "dest"]);
    nodes = [
      ...nodes,
      makeOutlineNode({
        id: "child",
        userId: USER,
        parentId: "src",
        prevSiblingId: null,
        text: "child",
        createdAt: 1,
        updatedAt: 1,
      }),
    ];
    const plan = planMirrorNode(buildTreeIndex(nodes), {
      id: "m1",
      userId: USER,
      sourceId: "src",
      targetParentId: "dest",
      createdAt: 2,
      updatedAt: 2,
    });
    expect(plan).not.toBeNull();
    expect(plan!.inserts).toHaveLength(1);
    expect(plan!.inserts[0]!.mirrorOf).toBe("src");
    expect(plan!.inserts[0]!.parentId).toBe("dest");
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, "dest")).toEqual(["m1"]);
  });

  it("flattens mirror-of-mirror to the true source", () => {
    let nodes = seedFlat(["src", "dest"]);
    {
      const plan = planMirrorNode(buildTreeIndex(nodes), {
        id: "m1",
        userId: USER,
        sourceId: "src",
        targetParentId: null,
        createdAt: 1,
        updatedAt: 1,
      });
      nodes = applyPlan(nodes, plan!);
    }
    const plan = planMirrorNode(buildTreeIndex(nodes), {
      id: "m2",
      userId: USER,
      sourceId: "m1",
      targetParentId: "dest",
      createdAt: 2,
      updatedAt: 2,
    });
    expect(plan).not.toBeNull();
    expect(plan!.inserts[0]!.mirrorOf).toBe("src");
  });

  it("refuses a cycle (mirror into own subtree)", () => {
    let nodes = seedFlat(["src"]);
    nodes = [
      ...nodes,
      makeOutlineNode({
        id: "child",
        userId: USER,
        parentId: "src",
        prevSiblingId: null,
        text: "child",
        createdAt: 1,
        updatedAt: 1,
      }),
    ];
    const plan = planMirrorNode(buildTreeIndex(nodes), {
      id: "m1",
      userId: USER,
      sourceId: "src",
      targetParentId: "child",
      createdAt: 2,
      updatedAt: 2,
    });
    expect(plan).toBeNull();
  });

  it("parents under the true source when target is a mirror instance", () => {
    let nodes = seedFlat(["src", "other"]);
    {
      const plan = planMirrorNode(buildTreeIndex(nodes), {
        id: "mDest",
        userId: USER,
        sourceId: "other",
        targetParentId: null,
        createdAt: 1,
        updatedAt: 1,
      });
      nodes = applyPlan(nodes, plan!);
    }
    const plan = planMirrorNode(buildTreeIndex(nodes), {
      id: "m1",
      userId: USER,
      sourceId: "src",
      targetParentId: "mDest",
      createdAt: 2,
      updatedAt: 2,
    });
    expect(plan).not.toBeNull();
    expect(plan!.inserts[0]!.parentId).toBe("other");
  });
});

describe("planIndent resolveMirror", () => {
  it("parents into the SOURCE when prev sibling is a mirror", () => {
    let nodes = seedFlat(["src", "m", "x"]);
    // Turn m into a mirror of src (same sibling chain position).
    nodes = nodes.map((n) =>
      n.id === "m" ? { ...n, mirrorOf: "src", text: "src" } : n,
    );
    const plan = planIndent(buildTreeIndex(nodes), "x", 10, true);
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(nodes.find((n) => n.id === "x")!.parentId).toBe("src");
    expect(assertChainOk(nodes, "src")).toEqual(["x"]);
  });

  it("refuses a cycle when mirror prev sibling resolves into self", () => {
    let nodes = seedFlat(["x", "m"]);
    nodes = nodes.map((n) =>
      n.id === "m" ? { ...n, mirrorOf: "x", text: "x" } : n,
    );
    // Indenting nothing after m that would cycle — indent m under x is fine.
    // Cycle: indent a node whose prev sibling mirrors THAT node.
    nodes = seedFlat(["a", "m", "b"]);
    nodes = nodes.map((n) =>
      n.id === "m" ? { ...n, mirrorOf: "b", text: "b" } : n,
    );
    // Indent b under m → would parent b under b (trueSourceOf m = b).
    expect(planIndent(buildTreeIndex(nodes), "b", 10, true)).toBeNull();
  });
});

describe("multi-select planners (ADR 0018)", () => {
  it("planRemoveMany deletes contiguous siblings without tearing the chain", () => {
    let nodes = seedFlat(["a", "b", "c", "d"]);
    const plan = planRemoveMany(nodes, ["b", "c"], 10);
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, null)).toEqual(["a", "d"]);
  });

  it("planMoveMany preserves order under the target", () => {
    let nodes = seedFlat(["t", "a", "b", "c"]);
    const plan = planMoveMany(nodes, {
      targetId: "t",
      nodeIds: ["a", "b"],
      updatedAt: 10,
    });
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, null)).toEqual(["t", "c"]);
    expect(assertChainOk(nodes, "t")).toEqual(["a", "b"]);
  });

  it("planIndentMany indents a run under the previous sibling", () => {
    let nodes = seedFlat(["a", "b", "c", "d"]);
    const plan = planIndentMany(nodes, ["b", "c"], 10);
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, null)).toEqual(["a", "d"]);
    expect(assertChainOk(nodes, "a")).toEqual(["b", "c"]);
  });

  it("planIndentMany resolveMirror parents into the SOURCE", () => {
    let nodes = seedFlat(["src", "m", "b", "c"]);
    nodes = nodes.map((n) =>
      n.id === "m" ? { ...n, mirrorOf: "src", text: "src" } : n,
    );
    const plan = planIndentMany(nodes, ["b", "c"], 10, true);
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, "src")).toEqual(["b", "c"]);
  });

  it("planOutdentMany lifts a run after the former parent", () => {
    let nodes = seedFlat(["p", "z"]);
    nodes = [
      ...nodes,
      makeOutlineNode({
        id: "a",
        userId: USER,
        parentId: "p",
        prevSiblingId: null,
        text: "a",
        createdAt: 1,
        updatedAt: 1,
      }),
      makeOutlineNode({
        id: "b",
        userId: USER,
        parentId: "p",
        prevSiblingId: "a",
        text: "b",
        createdAt: 2,
        updatedAt: 2,
      }),
    ];
    const plan = planOutdentMany(nodes, ["a", "b"], 10);
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, null)).toEqual(["p", "a", "b", "z"]);
  });
});

describe("planMaterializeDailyNodes", () => {
  it("inserts scaffold + day + seed in chain order", () => {
    let nodes: OutlineNode[] = [];
    const plan = planMaterializeDailyNodes(nodes, {
      userId: USER,
      inserts: [
        { id: "container", parentId: null, afterId: null, text: "Daily" },
        {
          id: "year",
          parentId: "container",
          afterId: null,
          text: "2026",
        },
        { id: "day", parentId: "year", afterId: null, text: "Tuesday" },
        { id: "seed", parentId: "day", afterId: null, text: "" },
      ],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, null)).toEqual(["container"]);
    expect(assertChainOk(nodes, "container")).toEqual(["year"]);
    expect(assertChainOk(nodes, "year")).toEqual(["day"]);
    expect(assertChainOk(nodes, "day")).toEqual(["seed"]);
  });

  it("skips ids already present", () => {
    let nodes = [
      makeOutlineNode({
        id: "container",
        userId: USER,
        parentId: null,
        prevSiblingId: null,
        text: "Daily",
        createdAt: 0,
        updatedAt: 0,
      }),
    ];
    const plan = planMaterializeDailyNodes(nodes, {
      userId: USER,
      inserts: [
        { id: "container", parentId: null, afterId: null, text: "Daily" },
        {
          id: "day",
          parentId: "container",
          afterId: null,
          text: "Tue",
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(plan).not.toBeNull();
    nodes = applyPlan(nodes, plan!);
    expect(assertChainOk(nodes, "container")).toEqual(["day"]);
  });
});
