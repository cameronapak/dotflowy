import { describe, expect, test } from "bun:test";

import {
  bridgeOrderedChildren,
  bridgeTreeIndex,
  outlineNodeToNode,
  rowsToOutlineNodes,
} from "./lunora-bridge";
import {
  applyPlan,
  buildTreeIndex,
  makeOutlineNode,
  nodeToDocFields,
  planIndent,
  planInsertSibling,
  planRemoveNode,
  type OutlineNode,
} from "./outline-plans";

const USER = "user-bridge";

function toRows(nodes: OutlineNode[]) {
  return nodes.map(nodeToDocFields);
}

describe("lunora-bridge (ADR 0004 seam)", () => {
  test("maps rows → OutlineNode via shared rowToNode", () => {
    const rows = [
      {
        _id: "a",
        parentId: null,
        prevSiblingId: null,
        text: "hello",
        isTask: false,
        completed: false,
        collapsed: false,
        bookmarkedAt: null,
        mirrorOf: null,
        createdAt: 1,
        updatedAt: 1,
        origin: null,
        kind: null,
        userId: USER,
      },
    ];
    expect(rowsToOutlineNodes(rows)).toEqual([
      expect.objectContaining({ id: "a", text: "hello", userId: USER }),
    ]);
    expect(outlineNodeToNode(rowsToOutlineNodes(rows)[0]!)).not.toHaveProperty(
      "userId",
    );
  });

  test("bridge order matches planner apply (insert/indent/remove)", () => {
    let nodes: OutlineNode[] = [
      makeOutlineNode({
        id: "a",
        userId: USER,
        parentId: null,
        prevSiblingId: null,
        text: "a",
        createdAt: 0,
        updatedAt: 0,
      }),
      makeOutlineNode({
        id: "b",
        userId: USER,
        parentId: null,
        prevSiblingId: "a",
        text: "b",
        createdAt: 1,
        updatedAt: 1,
      }),
    ];

    {
      const index = buildTreeIndex(nodes);
      const plan = planInsertSibling(index, {
        id: "c",
        userId: USER,
        parentId: null,
        afterId: "a",
        text: "c",
        createdAt: 2,
        updatedAt: 2,
      });
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }

    {
      const index = buildTreeIndex(nodes);
      const plan = planIndent(index, "c", 3);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }

    const bridged = bridgeTreeIndex(toRows(nodes));
    expect(bridgeOrderedChildren(bridged, null).map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
    expect(bridgeOrderedChildren(bridged, "a").map((n) => n.id)).toEqual(["c"]);

    {
      const index = buildTreeIndex(nodes);
      const plan = planRemoveNode(index, "a", 4);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }

    const afterRemove = bridgeTreeIndex(toRows(nodes));
    expect(bridgeOrderedChildren(afterRemove, null).map((n) => n.id)).toEqual([
      "b",
    ]);
  });
});
