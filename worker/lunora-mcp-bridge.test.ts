/**
 * Pure wiring: outline-ops ChangeOp batch → Lunora OutlinePlan
 * (mcp:applyChangeOps input). Full shard RPC stays integration-only.
 */

import { describe, expect, test } from "bun:test";

import { planFromChangeOps } from "../src/data/outline-plans";
import { makeNode } from "../src/data/tree";

describe("MCP → Lunora applyChangeOps plan", () => {
  test("planner batch becomes inserts/patches/deletes", () => {
    const a = makeNode({ id: "a", text: "alpha" });
    const plan = planFromChangeOps("user-1", [
      { op: "insert", value: a },
      { op: "update", value: { ...a, text: "ALPHA" } },
      { op: "delete", key: "z" },
    ]);
    expect(plan.inserts[0]!.userId).toBe("user-1");
    expect(plan.inserts[0]!.text).toBe("alpha");
    expect(plan.patches[0]!.fields.text).toBe("ALPHA");
    expect(plan.deletes).toEqual(["z"]);
  });
});
