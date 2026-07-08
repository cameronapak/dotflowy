import { describe, expect, test } from "bun:test";

import { resolvePlan } from "./plan";

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
