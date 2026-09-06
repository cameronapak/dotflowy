import { describe, expect, test } from "bun:test";

import type { OutlineNode } from "./types";

import { planFromChangeOps } from "./change-ops";
import { applyPlan, createOutlineNode } from "./planners";

/** The wire shape: a node minus the server-forced `userId`. */
function wire(node: OutlineNode) {
  const { userId: _u, ...rest } = node;
  return rest;
}

describe("planFromChangeOps", () => {
  test("maps insert/update/delete into one OutlinePlan", () => {
    const n1 = createOutlineNode({ id: "n1", userId: "u", text: "hello" });
    const n2 = createOutlineNode({ id: "n2", userId: "u", text: "world" });
    const plan = planFromChangeOps("u", [
      { op: "insert", value: wire(n1) },
      { op: "update", value: { ...wire(n2), text: "world!" } },
      { op: "delete", key: "gone" },
    ]);
    expect(plan.deletes).toEqual(["gone"]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]!.text).toBe("hello");
    expect(plan.inserts[0]!.userId).toBe("u");
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0]!.id).toBe("n2");
    expect(plan.patches[0]!.fields.text).toBe("world!");
  });

  // The plan's buckets are applied deletes → patches → inserts, which does NOT
  // preserve stream order. These assert on the APPLIED result, because that is
  // the only place a mis-bucketed op actually shows up.
  test("insert then update on one key lands the updated text", () => {
    const n1 = createOutlineNode({ id: "n1", userId: "u", text: "hello" });
    const plan = planFromChangeOps("u", [
      { op: "insert", value: wire(n1) },
      { op: "update", value: { ...wire(n1), text: "hello!" } },
    ]);
    const out = applyPlan([], plan);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("hello!");
  });

  test("insert then delete on one key leaves nothing behind", () => {
    const n1 = createOutlineNode({ id: "n1", userId: "u", text: "hello" });
    const plan = planFromChangeOps("u", [
      { op: "insert", value: wire(n1) },
      { op: "delete", key: "n1" },
    ]);
    expect(applyPlan([], plan)).toEqual([]);
  });

  test("update then delete on an existing key deletes it", () => {
    const live = createOutlineNode({ id: "n1", userId: "u", text: "old" });
    const plan = planFromChangeOps("u", [
      { op: "update", value: { ...wire(live), text: "new" } },
      { op: "delete", key: "n1" },
    ]);
    expect(applyPlan([live], plan)).toEqual([]);
  });

  test("delete then re-insert on one key keeps the re-inserted row", () => {
    const live = createOutlineNode({ id: "n1", userId: "u", text: "old" });
    const plan = planFromChangeOps("u", [
      { op: "delete", key: "n1" },
      { op: "insert", value: { ...wire(live), text: "reborn" } },
    ]);
    const out = applyPlan([live], plan);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("reborn");
  });

  test("repeated updates on one key collapse to the last", () => {
    const live = createOutlineNode({ id: "n1", userId: "u", text: "a" });
    const plan = planFromChangeOps("u", [
      { op: "update", value: { ...wire(live), text: "b" } },
      { op: "update", value: { ...wire(live), text: "c" } },
    ]);
    expect(plan.patches).toHaveLength(1);
    expect(applyPlan([live], plan)[0]!.text).toBe("c");
  });

  test("insert order follows first appearance, so sibling chains survive", () => {
    const a = createOutlineNode({ id: "a", userId: "u", text: "a" });
    const b = createOutlineNode({
      id: "b",
      userId: "u",
      text: "b",
      prevSiblingId: "a",
    });
    const plan = planFromChangeOps("u", [
      { op: "insert", value: wire(a) },
      { op: "insert", value: wire(b) },
      { op: "update", value: { ...wire(a), text: "a!" } },
    ]);
    expect(plan.inserts.map((n) => n.id)).toEqual(["a", "b"]);
    expect(plan.inserts[0]!.text).toBe("a!");
  });
});
