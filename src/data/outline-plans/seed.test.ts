import { expect, test } from "bun:test";

import { applyPlan } from "./index";
import { planSeedIfEmpty, seedEmptyOutline, shouldSeedOutline } from "./seed";

test("shouldSeedOutline only when ready and empty", () => {
  expect(shouldSeedOutline({ isReady: false, nodeCount: 0 })).toBe(false);
  expect(shouldSeedOutline({ isReady: true, nodeCount: 1 })).toBe(false);
  expect(shouldSeedOutline({ isReady: true, nodeCount: 0 })).toBe(true);
});

test("an empty outline gets a chained seed, and seeding again is a no-op", () => {
  const plan = planSeedIfEmpty([], {
    userId: "u1",
    createdAt: 1000,
    texts: ["one", "two"],
    ids: ["id-1", "id-2"],
  });
  expect(plan!.inserts).toEqual([
    expect.objectContaining({
      id: "id-1",
      userId: "u1",
      parentId: null,
      prevSiblingId: null,
      text: "one",
      createdAt: 1000,
      updatedAt: 1000,
    }),
    expect.objectContaining({
      id: "id-2",
      userId: "u1",
      parentId: null,
      prevSiblingId: "id-1",
      text: "two",
      createdAt: 1001,
      updatedAt: 1001,
    }),
  ]);
  expect(plan!.patches).toEqual([]);
  expect(plan!.deletes).toEqual([]);

  const seeded = applyPlan([], plan!);
  expect(planSeedIfEmpty(seeded, { userId: "u1", createdAt: 2000 })).toBeNull();
});

test("the default seed uses fixed ids so every tab converges on the same rows", () => {
  const plan = planSeedIfEmpty([], { userId: "u1", createdAt: 1 });
  expect(plan!.inserts.map((n) => n.id)).toEqual([
    "d0ef1001-5eed-4000-8000-000000000001",
    "d0ef1002-5eed-4000-8000-000000000002",
    "d0ef1003-5eed-4000-8000-000000000003",
    "d0ef1004-5eed-4000-8000-000000000004",
  ]);
});

test("seedEmptyOutline calls seedIfEmpty once with userId + createdAt", async () => {
  const calls: Array<{ userId: string; createdAt: number }> = [];
  await seedEmptyOutline({
    userId: "u1",
    now: () => 42,
    seedIfEmpty: async (args) => {
      calls.push(args);
    },
  });
  expect(calls).toEqual([{ userId: "u1", createdAt: 42 }]);
});
