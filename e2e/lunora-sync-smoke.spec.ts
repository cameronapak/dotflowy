import { expect, test, type Page } from "@playwright/test";

import { seedOutlineLunora, type SeedNode } from "./fixtures";

/**
 * Foundation smoke for ADR 0055 Lunora flag-ON path.
 * Uses `seedOutlineLunora` (mocks `/_lunora/*`). Classic suite stays on
 * `seedOutline` with the flag default OFF.
 *
 * Run with the Lunora subset: `bunx playwright test e2e/lunora-*.spec.ts`
 *
 * If this flakes locally (WS poke / watermark timing), keep the fixture and
 * treat this file as the path forward — do not rewrite the whole e2e suite yet.
 */

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const TREE: SeedNode[] = [
  { id: "smoke", parentId: null, prevSiblingId: null, text: "LunoraSmoke" },
];

test.describe("Lunora sync smoke (flag ON)", () => {
  test("loads seeded outline, edits survive reload", async ({ page }) => {
    await seedOutlineLunora(page, TREE);
    await page.goto("/");
    await expect(text(page, "smoke")).toBeVisible({ timeout: 15_000 });
    await expect(text(page, "smoke")).toHaveText("LunoraSmoke");

    // Place caret at end (contentEditable click can land mid-glyph / past text).
    await text(page, "smoke").click();
    await text(page, "smoke").evaluate((el) => {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type("X");
    await expect(text(page, "smoke")).toHaveText("LunoraSmokeX");

    // Watermark + mock store should hold the edit across a hard reload.
    await page.reload();
    await expect(text(page, "smoke")).toBeVisible({ timeout: 15_000 });
    await expect(text(page, "smoke")).toHaveText("LunoraSmokeX");
  });
});
