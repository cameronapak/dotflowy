import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE } from "./fixtures";

// A node's own editable text span.
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

// Every visible bullet's raw text in document order (empty new bullets show as
// ""), so a rolled-back insert is observable by the count returning to normal.
const orderedTexts = (page: Page) =>
  page.locator(".outline-row .node-text").allTextContents();

const saveFailedToast = (page: Page) =>
  page.locator("[data-sonner-toast]", {
    hasText: "Couldn't save your changes",
  });

// Drop the caret at the end of a bullet (Home/End/arrows are unreliable in
// macOS Chromium contentEditable; setting the Selection directly is not needed
// here since a fresh Enter appends at the caret we place by clicking the end).
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

test.describe("Save failure surfaces a toast and rolls back (#230)", () => {
  test("a failed structural write toasts and reverts the optimistic bullet", async ({
    page,
  }) => {
    // Seed loads normally; only structural-batch POSTs fail from here on.
    await seedOutline(page, STANDARD_TREE, { failStructuralWrites: true });
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();

    const before = await orderedTexts(page);

    // Enter at the end of "Alpha" is a structural insert (new sibling bullet) —
    // it routes through runStructural, whose batch POST the mock now 500s.
    await caretAtEnd(page, "alpha");
    await page.keyboard.press("Enter");

    // The failure toast appears...
    await expect(saveFailedToast(page)).toBeVisible({ timeout: 10_000 });

    // ...and the optimistic new bullet rolls back: the visible order returns to
    // exactly what it was before the Enter (no stray empty bullet survives).
    await expect
      .poll(() => orderedTexts(page), { timeout: 10_000 })
      .toEqual(before);
  });
});
