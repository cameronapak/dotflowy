import { describe, expect, it } from "vitest";

import {
  DEMO_SEED_TEXTS,
  seedEmptyOutline,
  shouldSeedOutline,
} from "./seed.js";

describe("seedEmptyOutline", () => {
  it("shouldSeedOutline only when ready and empty", () => {
    expect(shouldSeedOutline({ isReady: false, nodeCount: 0 })).toBe(false);
    expect(shouldSeedOutline({ isReady: true, nodeCount: 1 })).toBe(false);
    expect(shouldSeedOutline({ isReady: true, nodeCount: 0 })).toBe(true);
  });

  it("chains insertSibling with deterministic timestamps", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let n = 0;
    const ids = await seedEmptyOutline({
      userId: "u1",
      texts: ["one", "two"],
      newId: () => `id-${++n}`,
      now: () => 1000,
      insertSibling: async (args) => {
        calls.push(args);
      },
    });

    expect(ids).toEqual(["id-1", "id-2"]);
    expect(calls).toEqual([
      {
        id: "id-1",
        userId: "u1",
        parentId: null,
        afterId: null,
        text: "one",
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: "id-2",
        userId: "u1",
        parentId: null,
        afterId: "id-1",
        text: "two",
        createdAt: 1001,
        updatedAt: 1001,
      },
    ]);
  });

  it("default texts cover the demo bullets", async () => {
    const calls: Array<{ text: string }> = [];
    await seedEmptyOutline({
      userId: "u1",
      newId: () => crypto.randomUUID(),
      now: () => 1,
      insertSibling: async (args) => {
        calls.push({ text: args.text });
      },
    });
    expect(calls.map((c) => c.text)).toEqual([...DEMO_SEED_TEXTS]);
  });
});
