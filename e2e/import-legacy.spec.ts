import { expect, test, type Page } from "@playwright/test";
import { seedOutline } from "./fixtures";

// One-time localStorage -> D1 import (import-legacy.ts, ADR 0023). A user whose
// outline predates the D1 move has it sitting in the old localStorage
// collection under `dotflowy-oss:nodes`. On the first load against an empty D1,
// bootstrapOutline imports it instead of seeding the welcome bullets.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .node-text`);

interface LegacyNode {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
}

// Write the pre-D1 localStorage payload: TanStack DB's LocalStorageCollection
// shape, `{ "s:<id>": { versionKey, data } }`, under the legacy key. This is
// exactly what the old app persisted and what import-legacy.ts reads.
async function seedLegacyLocalStorage(page: Page, nodes: LegacyNode[]) {
  const store: Record<string, { versionKey: string; data: unknown }> = {};
  nodes.forEach((n, i) => {
    store[`s:${n.id}`] = {
      versionKey: `legacy-${i}`,
      data: {
        id: n.id,
        parentId: n.parentId,
        prevSiblingId: n.prevSiblingId,
        text: n.text,
        isTask: false,
        completed: false,
        collapsed: false,
        bookmarkedAt: null,
        createdAt: 0,
        updatedAt: 0,
      },
    };
  });
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["dotflowy-oss:nodes", JSON.stringify(store)] as const,
  );
}

const LEGACY: LegacyNode[] = [
  { id: "leg-a", parentId: null, prevSiblingId: null, text: "Imported parent" },
  { id: "leg-b", parentId: "leg-a", prevSiblingId: null, text: "Imported child" },
  { id: "leg-c", parentId: null, prevSiblingId: "leg-a", text: "Imported sibling" },
];

test.describe("legacy localStorage -> D1 import", () => {
  test("an empty D1 imports the old localStorage outline instead of seeding", async ({
    page,
  }) => {
    await seedOutline(page, []); // D1 starts empty
    await seedLegacyLocalStorage(page, LEGACY);
    await page.goto("/");

    // The legacy tree renders, nesting intact...
    await expect(text(page, "leg-a")).toHaveText("Imported parent");
    await expect(text(page, "leg-b")).toHaveText("Imported child");
    await expect(text(page, "leg-c")).toHaveText("Imported sibling");

    // ...and the first-run welcome seed did NOT also run (import won).
    await expect(
      page.locator("li[data-node-id]", { hasText: "Welcome to Dotflowy OSS" }),
    ).toHaveCount(0);
  });

  test("import is one-time: a reload neither re-imports nor seeds over it", async ({
    page,
  }) => {
    await seedOutline(page, []);
    await seedLegacyLocalStorage(page, LEGACY);
    await page.goto("/");
    await expect(text(page, "leg-a")).toHaveText("Imported parent");

    // Full reload: fresh JS context (module guards reset), but the mock D1 now
    // holds the imported nodes and localStorage carries the `d1-imported` flag.
    await page.reload();

    // Still exactly the imported tree -- no duplicate rows, no welcome bullets.
    await expect(text(page, "leg-a")).toHaveText("Imported parent");
    await expect(page.locator('li[data-node-id="leg-a"]')).toHaveCount(1);
    await expect(
      page.locator("li[data-node-id]", { hasText: "Welcome to Dotflowy OSS" }),
    ).toHaveCount(0);
  });

  test("a populated D1 is never clobbered by a stale legacy store", async ({
    page,
  }) => {
    // D1 already has the user's data (e.g. migrated on another device); the
    // local legacy store is obsolete and must not import over it.
    await seedOutline(page, [
      { id: "live", parentId: null, prevSiblingId: null, text: "Live D1 node" },
    ]);
    await seedLegacyLocalStorage(page, LEGACY);
    await page.goto("/");

    await expect(text(page, "live")).toHaveText("Live D1 node");
    await expect(page.locator('li[data-node-id="leg-a"]')).toHaveCount(0);
  });
});
