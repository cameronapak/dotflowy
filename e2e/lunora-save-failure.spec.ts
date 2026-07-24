import { expect, test, type Page } from "@playwright/test";

import { seedOutlineLunora, STANDARD_TREE } from "./fixtures";

/**
 * Lunora twin of `save-failure.spec.ts`: a failed mutator RPC must toast and
 * roll back optimistic UI — sticky `__tanstack_db_direct` must not keep a
 * rejected edit forever.
 *
 * Run: `bunx playwright test e2e/lunora-save-failure.spec.ts`
 */

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const orderedTexts = (page: Page) =>
  page.locator(".outline-row .node-text").allTextContents();

const saveFailedToast = (page: Page) =>
  page.locator("[data-sonner-toast]", {
    hasText: "Couldn't save your changes",
  });

async function caretAtEnd(page: Page, id: string) {
  const el = text(page, id);
  await el.click();
  await el.evaluate((node) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test.describe("Lunora save failure rolls back optimistic edits", () => {
  test("a failed structural mutator toasts and reverts the optimistic bullet", async ({
    page,
  }) => {
    await seedOutlineLunora(page, STANDARD_TREE, { failMutatorWrites: true });
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible({ timeout: 15_000 });

    const before = await orderedTexts(page);

    await caretAtEnd(page, "alpha");
    await page.keyboard.press("Enter");

    await expect(saveFailedToast(page)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => orderedTexts(page), { timeout: 10_000 })
      .toEqual(before);
  });
});
