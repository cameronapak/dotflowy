import { expect, test } from "bun:test";

import type { ChangeOp } from "../src/data/wire-schema";

import { createNode } from "../src/data/tree";
import {
  batchExceedsNodeLimit,
  countNetGrowth,
  nodeLimitForPlan,
  resolvePlan,
} from "./plan";

// Pure logic only (the repo's unit-test rule): the D1 query in getPlan is
// exercised end-to-end; resolvePlan is the decision it feeds.
test("resolvePlan picks the best known plan and fails closed on unknown names", () => {
  expect(resolvePlan([])).toBe("free");
  expect(resolvePlan([{ plan: "unlimited" }])).toBe("unlimited");
  expect(resolvePlan([{ plan: "founding" }])).toBe("founding");
  // Founding outranks unlimited regardless of row order.
  expect(resolvePlan([{ plan: "unlimited" }, { plan: "founding" }])).toBe(
    "founding",
  );
  expect(resolvePlan([{ plan: "founding" }, { plan: "unlimited" }])).toBe(
    "founding",
  );
  expect(resolvePlan([{ plan: "enterprise" }])).toBe("free");
  expect(resolvePlan([{ plan: "enterprise" }, { plan: "unlimited" }])).toBe(
    "unlimited",
  );
});

test("nodeLimitForPlan caps free at 10,000 nodes and leaves paid plans unlimited", () => {
  expect(nodeLimitForPlan("free")).toBe(10_000);
  expect(nodeLimitForPlan("unlimited")).toBeNull();
  expect(nodeLimitForPlan("founding")).toBeNull();
});

const CAP = 2000;

test.each([
  // [label, current, inserts, deletes, limit, exceeds]
  ["a paid user (null limit) is never capped", 999_999, 5000, 0, null, false],
  ["an insert landing exactly at the cap", 1998, 2, 0, CAP, false],
  ["an insert crossing the cap", 1998, 3, 0, CAP, true],
  ["one insert at the cap", CAP, 1, 0, CAP, true],
  ["a pure edit or move at the cap", CAP, 0, 0, CAP, false],
  ["a pure delete at the cap", CAP, 0, 5, CAP, false],
  ["a net-reducing batch that still adds", CAP, 3, 5, CAP, false],
  ["a net-zero replace at the cap", CAP, 1, 1, CAP, false],
  // A grandfathered (downgraded) over-cap outline can edit and delete but not grow.
  ["an edit on an over-cap outline", 2500, 0, 0, CAP, false],
  ["a delete on an over-cap outline", 2500, 0, 600, CAP, false],
  ["growth on an over-cap outline", 2500, 10, 0, CAP, true],
  ["growth once back under the cap", 1900, 50, 0, CAP, false],
])(
  "batchExceedsNodeLimit: %s",
  (_label, current, inserts, deletes, limit, exceeds) => {
    expect(batchExceedsNodeLimit(current, inserts, deletes, limit)).toBe(
      exceeds,
    );
  },
);

const ins = (id: string): ChangeOp => ({
  op: "insert",
  value: createNode({ id, text: id }),
});
const del = (id: string): ChangeOp => ({ op: "delete", key: id });

test.each([
  // [label, ops, ids existing pre-batch, inserts, deletes]
  ["plain inserts of new ids", [ins("a"), ins("b")], [], 2, 0],
  ["plain deletes of existing ids", [del("a"), del("b")], ["a", "b"], 0, 2],
  ["upserts of existing ids", [ins("a"), ins("b")], ["a", "b"], 0, 0],
  ["deleting an absent id", [del("a")], [], 0, 0],
  ["a duplicated upsert of one new id", [ins("a"), ins("a")], [], 1, 0],
  // THE BUG CASE: x is deleted then upserted again (last op wins, still present,
  // so NOT a delete) and y is new. Independent-set counting saw net 0, letting a
  // capped user grow past the ceiling.
  [
    "delete x + reinsert x + insert y",
    [del("x"), ins("x"), ins("y")],
    ["x"],
    1,
    0,
  ],
  ["insert-then-delete of a new id", [ins("x"), del("x")], [], 0, 0],
])("countNetGrowth: %s", (_label, ops, existing, inserts, deletes) => {
  const exists = (id: string) => existing.includes(id);
  expect(countNetGrowth(ops, exists)).toEqual({ inserts, deletes });
});
