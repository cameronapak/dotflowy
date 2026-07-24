import { expect, test, type Page } from "@playwright/test";

import { seedOutlineLunora, type SeedNode } from "./fixtures";

/**
 * Pins the Lunora sticky-optimistic typing fix: when a `wholeOutline` shape
 * poke is missed, the ~3s checkpoint fallback must NOT drop typed text
 * (Settings → back used to look empty until hard refresh).
 *
 * Run: `bunx playwright test e2e/lunora-optimistic-hold.spec.ts`
 */

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const TREE: SeedNode[] = [
  { id: "hold", parentId: null, prevSiblingId: null, text: "HoldBase" },
];

test.describe("Lunora optimistic hold (missed shape poke)", () => {
  test("typed text survives 3s fallback and Settings round-trip", async ({
    page,
  }) => {
    await seedOutlineLunora(page, TREE, { suppressWholeOutlinePoke: true });
    await page.goto("/");
    await expect(text(page, "hold")).toBeVisible({ timeout: 15_000 });
    await expect(text(page, "hold")).toHaveText("HoldBase");

    await text(page, "hold").click();
    await page.keyboard.type("X");
    await expect(text(page, "hold")).toHaveText("HoldBaseX");

    // Past SHAPE_CHECKPOINT_FALLBACK_MS — without sticky-direct the overlay
    // would revert to HoldBase here.
    await expect(text(page, "hold")).toHaveText("HoldBaseX", {
      timeout: 5_000,
    });
    await page.waitForTimeout(3_500);
    await expect(text(page, "hold")).toHaveText("HoldBaseX");

    // SPA remount of the outline (the surface that made the bug obvious).
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({
      timeout: 10_000,
    });
    await page.goto("/");
    await expect(text(page, "hold")).toBeVisible({ timeout: 15_000 });
    await expect(text(page, "hold")).toHaveText("HoldBaseX");
  });
});
