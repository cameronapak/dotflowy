import { expect, test, type Page } from "@playwright/test";

import { placeCaret, seedOutline, STANDARD_TREE, text } from "./fixtures";

// Every visible bullet's raw text in document order (empty new bullets show as
// ""), so a rolled-back insert is observable by the count returning to normal.
const orderedTexts = (page: Page) =>
  page.locator(".outline-row .node-text").allTextContents();

const saveFailedToast = (page: Page) =>
  page.locator("[data-sonner-toast]", {
    hasText: "Couldn't save your changes",
  });

// Drop the caret at the end of a bullet before the structural Enter.
async function caretAtEnd(page: Page, id: string) {
  await placeCaret(text(page, id), "end");
}

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
