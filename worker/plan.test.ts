import { describe, expect, test } from "bun:test";

import {
  batchExceedsNodeLimit,
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
