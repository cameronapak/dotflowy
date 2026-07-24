import { describe, expect, test } from "bun:test";

import { planFromChangeOps } from "./change-ops";
import { makeOutlineNode } from "./planners";

describe("planFromChangeOps", () => {
  test("maps insert/update/delete into one OutlinePlan", () => {
    const insert = makeOutlineNode({
      id: "n1",
      userId: "u",
      text: "hello",
    });
    const { userId: _u, ...insertWire } = insert;
    const plan = planFromChangeOps("u", [
      { op: "insert", value: insertWire },
      {
        op: "update",
        value: { ...insertWire, text: "hello!" },
      },
      { op: "delete", key: "gone" },
    ]);
    expect(plan.deletes).toEqual(["gone"]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]!.text).toBe("hello");
    expect(plan.inserts[0]!.userId).toBe("u");
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0]!.id).toBe("n1");
    expect(plan.patches[0]!.fields.text).toBe("hello!");
  });
});
