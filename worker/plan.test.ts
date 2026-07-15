import { describe, expect, test } from "bun:test";

import type { ChangeOp } from "../src/data/wire-schema";

import { makeNode } from "../src/data/tree";
import {
  batchExceedsNodeLimit,
  countNetGrowth,
  FREE_NODE_LIMIT,
  nodeLimitForPlan,
  resolvePlan,
} from "./plan";

// Pure logic only (the repo's unit-test rule): the D1 query in getPlan is
// exercised end-to-end; resolvePlan is the decision it feeds.
describe("resolvePlan", () => {
  test("no rows = free", () => {
    expect(resolvePlan([])).toBe("free");
  });

  test("an unlimited row grants unlimited", () => {
    expect(resolvePlan([{ plan: "unlimited" }])).toBe("unlimited");
  });

  test("a founding row grants founding", () => {
    expect(resolvePlan([{ plan: "founding" }])).toBe("founding");
  });

  test("founding outranks unlimited regardless of row order", () => {
    expect(resolvePlan([{ plan: "unlimited" }, { plan: "founding" }])).toBe(
      "founding",
    );
    expect(resolvePlan([{ plan: "founding" }, { plan: "unlimited" }])).toBe(
      "founding",
    );
  });

  test("unknown plan names grant nothing (fail closed)", () => {
    expect(resolvePlan([{ plan: "enterprise" }])).toBe("free");
    expect(resolvePlan([{ plan: "enterprise" }, { plan: "unlimited" }])).toBe(
      "unlimited",
    );
  });
});

describe("nodeLimitForPlan", () => {
  test("free is capped, paid is unlimited (null)", () => {
    expect(nodeLimitForPlan("free")).toBe(FREE_NODE_LIMIT);
    expect(nodeLimitForPlan("unlimited")).toBeNull();
    expect(nodeLimitForPlan("founding")).toBeNull();
  });
});

describe("batchExceedsNodeLimit", () => {
  const CAP = 2000;

  test("a paid user (null limit) is never capped", () => {
    expect(batchExceedsNodeLimit(999_999, 5000, 0, null)).toBe(false);
  });

  test("an under-cap insert that stays within the cap is allowed", () => {
    expect(batchExceedsNodeLimit(1998, 2, 0, CAP)).toBe(false); // lands exactly at 2000
  });

  test("an insert that would cross the cap is refused", () => {
    expect(batchExceedsNodeLimit(1998, 3, 0, CAP)).toBe(true); // -> 2001
    expect(batchExceedsNodeLimit(CAP, 1, 0, CAP)).toBe(true); // at cap, +1
  });

  test("deletes/moves/edits are never blocked (no growth)", () => {
    expect(batchExceedsNodeLimit(CAP, 0, 0, CAP)).toBe(false); // pure edit/move
    expect(batchExceedsNodeLimit(CAP, 0, 5, CAP)).toBe(false); // pure delete
  });

  test("an already over-cap (downgraded) outline is never locked", () => {
    // A grandfathered 2500-node outline can still edit, move, and delete.
    expect(batchExceedsNodeLimit(2500, 0, 0, CAP)).toBe(false);
    expect(batchExceedsNodeLimit(2500, 0, 600, CAP)).toBe(false);
    // ...but cannot grow further while over cap.
    expect(batchExceedsNodeLimit(2500, 10, 0, CAP)).toBe(true);
    // Once reduced back under the cap, inserts flow again.
    expect(batchExceedsNodeLimit(1900, 50, 0, CAP)).toBe(false);
  });

  test("a net-reducing batch that still adds is allowed (final <= before)", () => {
    // delete 5, insert 3 at cap -> 1998, not growth -> allowed.
    expect(batchExceedsNodeLimit(CAP, 3, 5, CAP)).toBe(false);
    // a net-zero replace at cap is allowed (never locks).
    expect(batchExceedsNodeLimit(CAP, 1, 1, CAP)).toBe(false);
  });
});

describe("countNetGrowth", () => {
  const ins = (id: string): ChangeOp => ({
    op: "insert",
    value: makeNode({ id, text: id }),
  });
  const del = (id: string): ChangeOp => ({ op: "delete", key: id });
  // A pre-batch existence probe backed by the set of ids already in the outline.
  const existsIn = (ids: string[]) => (id: string) => ids.includes(id);

  test("plain inserts of new ids count as inserts", () => {
    expect(countNetGrowth([ins("a"), ins("b")], existsIn([]))).toEqual({
      inserts: 2,
      deletes: 0,
    });
  });

  test("plain deletes of existing ids count as deletes", () => {
    expect(countNetGrowth([del("a"), del("b")], existsIn(["a", "b"]))).toEqual({
      inserts: 0,
      deletes: 2,
    });
  });

  test("updating existing ids is zero growth", () => {
    // An upsert of an id that already exists is neither insert nor delete.
    expect(countNetGrowth([ins("a"), ins("b")], existsIn(["a", "b"]))).toEqual({
      inserts: 0,
      deletes: 0,
    });
  });

  test("deleting an absent id is zero growth", () => {
    expect(countNetGrowth([del("a")], existsIn([]))).toEqual({
      inserts: 0,
      deletes: 0,
    });
  });

  test("a duplicated upsert of the same new id is one insert", () => {
    expect(countNetGrowth([ins("a"), ins("a")], existsIn([]))).toEqual({
      inserts: 1,
      deletes: 0,
    });
  });

  test("THE BUG CASE: delete X + reinsert X + insert Y nets +1, not +0", () => {
    // X exists pre-batch, is deleted, then upserted again (last op wins → still
    // present → NOT a delete); Y is genuinely new. Independent-set counting saw
    // deletes:1/inserts:1 → net 0, letting a capped user grow past the ceiling.
    expect(
      countNetGrowth([del("x"), ins("x"), ins("y")], existsIn(["x"])),
    ).toEqual({ inserts: 1, deletes: 0 });
  });

  test("insert-then-delete of a new id nets zero (ends absent, never existed)", () => {
    expect(countNetGrowth([ins("x"), del("x")], existsIn([]))).toEqual({
      inserts: 0,
      deletes: 0,
    });
  });
});
