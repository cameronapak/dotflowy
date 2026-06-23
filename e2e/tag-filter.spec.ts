import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Tags are a plugin (ADR 0018): the chip render is a token, and the click ->
// filter / right-click -> color picker route through the core's delegated
// interaction dispatch (Seam B). This spec locks in that plugin-routed
// behavior, which the editor-internal specs don't otherwise touch.

const TAGGED_TREE: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "Buy milk #work" },
  { id: "b", parentId: null, prevSiblingId: "a", text: "Call mom" },
  { id: "c", parentId: null, prevSiblingId: "b", text: "Ship it #work" },
];

const row = (page: Page, id: string) => page.locator(`li[data-node-id="${id}"]`);

async function load(page: Page) {
  await seedOutline(page, TAGGED_TREE);
  await page.goto("/");
  await expect(row(page, "a").first()).toBeVisible();
}

test.describe("tag filtering (plugin Seam B)", () => {
  test("clicking a #tag chip filters the outline to matching nodes", async ({
    page,
  }) => {
    await load(page);

    // The chip is decorated by the tags plugin's token render.
    await page.locator('.tag[data-tag="work"]').first().click();

    // The click AND-s the tag into the URL-driven filter (ctx.nav.filterTag).
    await expect(page).toHaveURL(/q=%23work/);
    await expect(page.locator(".tag-filter-bar")).toBeVisible();

    // Matching nodes stay; the untagged one is pruned out of the render.
    await expect(row(page, "a").first()).toBeVisible();
    await expect(row(page, "c").first()).toBeVisible();
    await expect(row(page, "b")).toHaveCount(0);
  });

  test("right-clicking a #tag chip opens the color picker overlay", async ({
    page,
  }) => {
    await load(page);

    await page.locator('.tag[data-tag="work"]').first().click({
      button: "right",
    });

    // The tags plugin routes the context menu through ctx.openOverlay, which
    // the core mounts as a self-managing portal.
    await expect(
      page.locator('[role="menu"][aria-label="Color for #work"]'),
    ).toBeVisible();
  });
});
