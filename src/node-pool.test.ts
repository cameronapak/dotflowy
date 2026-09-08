import { expect, test } from "vitest";

// Canary (ADR 0061): proves the src node pool boots. Pure logic only.
test("node pool boots", () => {
  expect(1 + 1).toBe(2);
});
