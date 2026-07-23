import {
  DEMO_SEED_IDS,
  planSeedIfEmpty,
  shouldSeedOutline,
} from "@dotflowy/outline-plans";
import { describe, expect, it } from "vitest";

describe("shared seed planner (spike import smoke)", () => {
  it("planSeedIfEmpty no-ops when non-empty", () => {
    expect(shouldSeedOutline({ isReady: true, nodeCount: 0 })).toBe(true);
    expect(
      planSeedIfEmpty(
        [
          {
            id: "x",
            parentId: null,
            prevSiblingId: null,
            text: "x",
            isTask: false,
            completed: false,
            collapsed: false,
            bookmarkedAt: null,
            mirrorOf: null,
            createdAt: 1,
            updatedAt: 1,
            origin: null,
            kind: null,
            userId: "u",
          },
        ],
        { userId: "u", createdAt: 1 },
      ),
    ).toBeNull();
  });

  it("uses DEMO_SEED_IDS by default", () => {
    const plan = planSeedIfEmpty([], { userId: "u", createdAt: 1 });
    expect(plan!.inserts.map((n) => n.id)).toEqual([...DEMO_SEED_IDS]);
  });
});
