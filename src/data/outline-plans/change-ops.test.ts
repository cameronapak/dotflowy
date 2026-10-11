import { expect, test } from "bun:test";

import type { ChangeOpLike } from "./change-ops";
import type { OutlineNode } from "./types";

import { planFromChangeOps } from "./change-ops";
import { applyPlan, createOutlineNode } from "./planners";

/** The wire shape: a node minus the server-forced `userId`. */
function wire(node: OutlineNode) {
  const { userId: _u, ...rest } = node;
  return rest;
}

test("maps insert/update/delete into one OutlinePlan under the server's userId", () => {
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
// preserve stream order. Assert on the APPLIED result, because that is the
// only place a mis-bucketed op actually shows up.
const n1 = createOutlineNode({ id: "n1", userId: "u", text: "old" });
test.each<[string, OutlineNode[], ChangeOpLike[], string[]]>([
  [
    "insert then update lands the updated text",
    [],
    [
      { op: "insert", value: wire(n1) },
      { op: "update", value: { ...wire(n1), text: "hello!" } },
    ],
    ["hello!"],
  ],
  [
    "insert then delete leaves nothing behind",
    [],
    [
      { op: "insert", value: wire(n1) },
      { op: "delete", key: "n1" },
    ],
    [],
  ],
  [
    "update then delete on an existing key deletes it",
    [n1],
    [
      { op: "update", value: { ...wire(n1), text: "new" } },
      { op: "delete", key: "n1" },
    ],
    [],
  ],
  [
    "delete then re-insert keeps the re-inserted row",
    [n1],
    [
      { op: "delete", key: "n1" },
      { op: "insert", value: { ...wire(n1), text: "reborn" } },
    ],
    ["reborn"],
  ],
  [
    "repeated updates collapse to the last",
    [n1],
    [
      { op: "update", value: { ...wire(n1), text: "b" } },
      { op: "update", value: { ...wire(n1), text: "c" } },
    ],
    ["c"],
  ],
])("one key: %s", (_name, live, ops, texts) => {
  expect(
    applyPlan(live, planFromChangeOps("u", ops)).map((n) => n.text),
  ).toEqual(texts);
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
