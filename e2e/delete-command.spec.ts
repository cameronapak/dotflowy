import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// A node's OWN editable text span.
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

// The zoomed page title's editable span (the SECOND render path -- not in an
// `li`, so it needs its own selector). See ZoomedTitle in OutlineEditor.tsx.
const title = (page: Page) => page.locator(".zoomed-title .node-text");

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
    // Focus lands on the visible row directly ABOVE the deleted one (Workflowy
    // backspace behavior). Nothing is collapsed, so that's alpha's last visible
    // child `alpha-2`, NOT `alpha` itself.
    await expect(text(page, "alpha-2")).toBeFocused();
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
    // Nothing sits above the first top-level node, so focus falls back to
    // removeNode's structural pick -- the next sibling, `bravo`.
    await expect(text(page, "bravo")).toBeFocused();
  });

  // The zoomed title is the second render path (its own keymap), so the slash
  // menu has to be wired there separately. Prove `/delete` works from the title.
  test("runs from the zoomed page title", async ({ page }) => {
    await load(page, STANDARD_TREE);
    await page.goto("/alpha"); // zoom in: `alpha` is now the page title
    await expect(title(page)).toBeVisible();

    await title(page).click();
    await expect(title(page)).toBeFocused();
    await page.keyboard.type(" /delete");
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Delete", exact: false }),
    ).toBeVisible();
    await page.keyboard.press("Enter");

    // Deleting the zoom root leaves the deep-link on a now-missing node, so the
    // editor shows its "doesn't exist" placeholder rather than crashing.
    await expect(
      page.getByText("That bullet doesn't exist", { exact: false }),
    ).toBeVisible();
  });
});
