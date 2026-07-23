import { expect, test, type Page } from "@playwright/test";

import { seedOutlineLunora, STANDARD_TREE, type SeedNode } from "./fixtures";

/**
 * Lunora flag-ON structural subset — proves enter-split / indent / delete
 * ride `seedOutlineLunora` (planner-backed `/_lunora/rpc` mock).
 *
 * Run: `bunx playwright test e2e/lunora-*.spec.ts`
 * Classic suite stays on `seedOutline` (flag OFF).
 */

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

const focused = (page: Page) => page.locator(".node-text:focus");

const orderedTexts = (page: Page) =>
  page.locator(".outline-row .node-text").allTextContents();

async function load(page: Page, tree: SeedNode[]) {
  await seedOutlineLunora(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible({ timeout: 15_000 });
}

async function caretAt(page: Page, id: string, col: number) {
  await text(page, id).click();
  await text(page, id).evaluate((el, target) => {
    const sel = window.getSelection();
    if (!sel) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    const range = document.createRange();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
      node = walker.nextNode();
    }
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }, col);
}

test.describe("Lunora structural (flag ON)", () => {
  test("Enter mid-text splits into a sibling", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
    ]);

    await caretAt(page, "n", 5);
    await page.keyboard.press("Enter");

    await expect(text(page, "n")).toHaveText("alpha");
    await expect(focused(page)).toHaveText("bravo");
    expect(await orderedTexts(page)).toEqual(["alpha", "bravo"]);
  });

  test("Tab indents under the previous sibling", async ({ page }) => {
    await load(page, [
      { id: "a", parentId: null, prevSiblingId: null, text: "Alpha" },
      { id: "b", parentId: null, prevSiblingId: "a", text: "Bravo" },
    ]);

    await text(page, "b").click();
    await page.keyboard.press("Tab");

    await expect(row(page, "b")).toHaveAttribute("data-parent-id", "a");
    await expect(row(page, "b")).toHaveAttribute("data-depth", "1");
  });

  test("/delete removes a leaf and persists across reload", async ({
    page,
  }) => {
    await load(page, STANDARD_TREE);

    await text(page, "bravo").click();
    await page.keyboard.type(" /delete");
    await expect(page.getByRole("listbox")).toBeVisible();
    // Await the remove mutator before reload — fire-and-forget watermark can
    // race page.reload() and resurrect the leaf from the mock store.
    const removed = page.waitForResponse(
      (r) =>
        r.url().includes("/_lunora/rpc") &&
        r.request().method() === "POST" &&
        (r.request().postData() ?? "").includes("mutators:removeNode"),
    );
    await page.keyboard.press("Enter");
    await removed;

    await expect(row(page, "bravo")).toHaveCount(0);
    await expect(text(page, "alpha")).toBeVisible();
    await expect(text(page, "charlie")).toBeVisible();

    await page.reload();
    await expect(text(page, "alpha")).toBeVisible({ timeout: 15_000 });
    await expect(row(page, "bravo")).toHaveCount(0);
    await expect(text(page, "charlie")).toBeVisible();
  });
});
