import {
  applyPlan,
  buildTreeIndex,
  childrenOf,
  makeOutlineNode,
  planInsertSibling,
} from "@dotflowy/outline-plans";
/**
 * Spike keeps a thin vitest entry that re-runs shared planner tests via
 * import. Canonical coverage lives in
 * `src/data/outline-plans/planners.test.ts` (`bun run test`).
 */
import { describe, expect, it } from "vitest";

describe("shared outline-plans (spike import smoke)", () => {
  it("planInsertSibling mid-list via @dotflowy/outline-plans", () => {
    const nodes = [
      makeOutlineNode({
        id: "a",
        userId: "u",
        parentId: null,
        prevSiblingId: null,
        text: "a",
        createdAt: 0,
        updatedAt: 0,
      }),
      makeOutlineNode({
        id: "b",
        userId: "u",
        parentId: null,
        prevSiblingId: "a",
        text: "b",
        createdAt: 1,
        updatedAt: 1,
      }),
    ];
    const plan = planInsertSibling(buildTreeIndex(nodes), {
      id: "x",
      userId: "u",
      parentId: null,
      afterId: "a",
      text: "x",
      createdAt: 2,
      updatedAt: 2,
    });
    expect(plan).not.toBeNull();
    const next = applyPlan(nodes, plan!);
    expect(childrenOf(buildTreeIndex(next), null).map((n) => n.id)).toEqual([
      "a",
      "x",
      "b",
    ]);
  });
});
