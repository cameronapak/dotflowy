import { describe, expect, it } from "vitest";

import type { OutlineNode } from "./types.js";

import {
  bridgeOrderedChildren,
  bridgeTreeIndex,
  rowsToOutlineNodes,
} from "./lunora-bridge.js";
import { nodeToDocFields } from "./map-node.js";
import {
  applyPlan,
  planIndent,
  planInsertSibling,
  planRemoveNode,
} from "./planners.js";
import { buildTreeIndex } from "./tree.js";

const USER = "user-bridge";

function toRows(nodes: OutlineNode[]) {
  return nodes.map(nodeToDocFields);
}

describe("lunora-bridge (ADR 0004 seam)", () => {
  it("maps rows → OutlineNode via shared rowToNode", () => {
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
      {
        id: "a",
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
    ]);
  });

  it("insert / indent / remove via planners → bridge order matches", () => {
    let nodes: OutlineNode[] = [];
    let t = 100;

    // Insert a, b, c at top level
    for (const id of ["a", "b", "c"] as const) {
      const index = buildTreeIndex(nodes);
      const afterId = nodes.length === 0 ? null : nodes[nodes.length - 1]!.id;
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
      t += 1;
    }

    {
      const bridged = bridgeTreeIndex(toRows(nodes));
      expect(bridgeOrderedChildren(bridged, null).map((n) => n.id)).toEqual([
        "a",
        "b",
        "c",
      ]);
    }

    // Indent c under b → a, b(c)
    {
      const index = buildTreeIndex(nodes);
      const plan = planIndent(index, "c", t++);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }

    {
      const bridged = bridgeTreeIndex(toRows(nodes));
      expect(bridgeOrderedChildren(bridged, null).map((n) => n.id)).toEqual([
        "a",
        "b",
      ]);
      expect(bridgeOrderedChildren(bridged, "b").map((n) => n.id)).toEqual([
        "c",
      ]);
    }

    // Remove b (and cascade semantics from planRemoveNode)
    {
      const index = buildTreeIndex(nodes);
      const plan = planRemoveNode(index, "b", t++);
      expect(plan).not.toBeNull();
      nodes = applyPlan(nodes, plan!);
    }

    {
      const bridged = bridgeTreeIndex(toRows(nodes));
      const top = bridgeOrderedChildren(bridged, null).map((n) => n.id);
      // planRemoveNode removes the subtree — expect only "a"
      expect(top).toEqual(["a"]);
      expect(bridged.byId.has("b")).toBe(false);
      expect(bridged.byId.has("c")).toBe(false);
    }
  });
});
