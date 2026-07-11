import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// A node's OWN editable text span.
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

/**
 * Open the slash palette on a node and run `/delete` the way a user does: focus
 * the bullet, type the command after a space (so `detectSlash` fires -- a "/"
 * mid-word is ignored), then Enter. See slash-menu.tsx / move-dialog.spec.ts.
 */
async function slashDelete(page: Page, id: string) {
  await text(page, id).click();
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(" /delete");
  await expect(page.getByRole("listbox")).toBeVisible(); // the slash menu
  await expect(
    page.getByRole("option", { name: "Delete", exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
}

test.describe("/delete slash command", () => {
  test("removes a leaf node, leaving its siblings", async ({ page }) => {
    await load(page, STANDARD_TREE);
    await slashDelete(page, "bravo");

    await expect(row(page, "bravo")).toHaveCount(0);
    // Siblings survive; the sibling chain still renders both.
    await expect(text(page, "alpha")).toBeVisible();
    await expect(text(page, "charlie")).toBeVisible();
  });

  test("removes the node's whole subtree in one shot", async ({ page }) => {
    await load(page, STANDARD_TREE);
    await slashDelete(page, "alpha");

    // The root and both of its children are gone (below the confirm threshold,
    // so it deletes inline -- no dialog).
    await expect(row(page, "alpha")).toHaveCount(0);
    await expect(row(page, "alpha-1")).toHaveCount(0);
    await expect(row(page, "alpha-2")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(text(page, "bravo")).toBeVisible();
  });
});
