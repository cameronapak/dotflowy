import { expect, test, type Page } from "@playwright/test";

import { seedOutlineLunora, type SeedNode } from "./fixtures";

/**
 * Lunora flag-ON undo/redo via `mutators:restoreNodes` (mock applies
 * planRestoreNodes). Small undos only — sliced modal path stays classic e2e.
 *
 * Run: `bunx playwright test e2e/lunora-*.spec.ts`
 */

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

const TREE: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "Alpha" },
  { id: "b", parentId: null, prevSiblingId: "a", text: "Bravo" },
  { id: "c", parentId: null, prevSiblingId: "b", text: "Charlie" },
];

test.describe("Lunora undo/redo (flag ON)", () => {
  test("Cmd+Z restores a deleted leaf; Cmd+Shift+Z re-deletes", async ({
    page,
  }) => {
    await seedOutlineLunora(page, TREE);
    await page.goto("/");
    await expect(text(page, "a")).toBeVisible({ timeout: 15_000 });

    await text(page, "b").click();
    await page.keyboard.type(" /delete");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(row(page, "b")).toHaveCount(0);

    await text(page, "a").click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(text(page, "b")).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(row(page, "b")).toHaveCount(0);

    // Persisted through the mock store.
    await page.reload();
    await expect(text(page, "a")).toBeVisible({ timeout: 15_000 });
    await expect(row(page, "b")).toHaveCount(0);
    await expect(text(page, "c")).toBeVisible();
  });
});
