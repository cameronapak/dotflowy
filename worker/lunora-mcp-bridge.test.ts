/**
 * Pure wiring: outline-ops ChangeOp batch → Lunora OutlinePlan
 * (mcp:applyChangeOps input). Full shard RPC stays integration-only.
 */

import { describe, expect, test } from "vitest";

import { planFromChangeOps } from "../src/data/outline-plans";
import { createNode } from "../src/data/tree";

describe("MCP → Lunora applyChangeOps plan", () => {
  test("planner batch becomes inserts/patches/deletes", () => {
    const a = createNode({ id: "a", text: "alpha" });
    const b = createNode({ id: "b", text: "bravo" });
    const plan = planFromChangeOps("user-1", [
      { op: "insert", value: a },
      { op: "update", value: { ...b, text: "BRAVO" } },
      { op: "delete", key: "z" },
    ]);
    expect(plan.inserts[0]!.userId).toBe("user-1");
    expect(plan.inserts[0]!.text).toBe("alpha");
    expect(plan.patches[0]!.fields.text).toBe("BRAVO");
    expect(plan.deletes).toEqual(["z"]);
  });

  test("an insert and a later update on ONE key fold into one insert", () => {
    // The buckets apply deletes → patches → inserts, so an un-coalesced batch
    // would run this patch before its row exists and drop the update entirely.
    const a = createNode({ id: "a", text: "alpha" });
    const plan = planFromChangeOps("user-1", [
      { op: "insert", value: a },
      { op: "update", value: { ...a, text: "ALPHA" } },
    ]);
    expect(plan.patches).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]!.text).toBe("ALPHA");
  });
});
