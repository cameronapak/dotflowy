import { describe, expect, it } from "vitest";

import { applyPlan, buildTreeIndex, childrenOf } from "./index.js";
import {
  DEMO_SEED_IDS,
  DEMO_SEED_TEXTS,
  planSeedIfEmpty,
  seedEmptyOutline,
  shouldSeedOutline,
} from "./seed.js";

describe("planSeedIfEmpty", () => {
  it("shouldSeedOutline only when ready and empty", () => {
    expect(shouldSeedOutline({ isReady: false, nodeCount: 0 })).toBe(false);
    expect(shouldSeedOutline({ isReady: true, nodeCount: 1 })).toBe(false);
    expect(shouldSeedOutline({ isReady: true, nodeCount: 0 })).toBe(true);
  });

  it("returns null when any nodes exist (idempotent no-op)", () => {
    const plan = planSeedIfEmpty(
      [
        {
          id: "x",
          parentId: null,
          prevSiblingId: null,
          text: "existing",
          isTask: false,
          completed: false,
          collapsed: false,
          bookmarkedAt: null,
          mirrorOf: null,
          createdAt: 1,
          updatedAt: 1,
          origin: null,
          kind: null,
          userId: "u1",
        },
      ],
      { userId: "u1", createdAt: 1000 },
    );
    expect(plan).toBeNull();
  });

  it("inserts demo chain with deterministic ids + timestamps", () => {
    const plan = planSeedIfEmpty([], {
      userId: "u1",
      createdAt: 1000,
      texts: ["one", "two"],
      ids: ["id-1", "id-2"],
    });
    expect(plan).not.toBeNull();
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

    const index = buildTreeIndex(applyPlan([], plan!));
    expect(childrenOf(index, null).map((n) => n.id)).toEqual(["id-1", "id-2"]);
  });

  it("default texts/ids cover the demo bullets", () => {
    const plan = planSeedIfEmpty([], { userId: "u1", createdAt: 1 });
    expect(plan).not.toBeNull();
    expect(plan!.inserts.map((n) => n.text)).toEqual([...DEMO_SEED_TEXTS]);
    expect(plan!.inserts.map((n) => n.id)).toEqual([...DEMO_SEED_IDS]);
  });
});

describe("seedEmptyOutline", () => {
  it("calls seedIfEmpty once with userId + createdAt", async () => {
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
});
