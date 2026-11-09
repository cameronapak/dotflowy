import { expect, test, type Page } from "@playwright/test";

import { openSeededOutline, seedOutline, type SeedNode } from "./fixtures";

// Tags are a plugin (ADR 0018): the chip render is a token, and clicking it
// filters through the core's delegated interaction dispatch (Seam B).

const TAGGED_TREE: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "Buy milk #work" },
  { id: "b", parentId: null, prevSiblingId: "a", text: "Call mom" },
  { id: "c", parentId: null, prevSiblingId: "b", text: "Ship it #work" },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

async function load(page: Page) {
  await seedOutline(page, TAGGED_TREE);
  await openSeededOutline(page, { anchorId: "a" });
}

test("a #tag chip filters to matches; Clear restores the view and closes the subheader", async ({
  page,
}) => {
  await load(page);

  // The chip is decorated by the tags plugin's token render.
  await page.locator('.tag[data-tag="work"]').first().click();

  // The click AND-s the tag into the URL-driven filter (tags plugin).
  await expect(page).toHaveURL(/q=%23work/);
  // The filter bar is generalized core chrome now (ADR 0047 §6): aria-label
  // "Filter", not "Tag filter".
  await expect(page.getByRole("search", { name: "Filter" })).toBeVisible();

  // Matching nodes stay; the untagged one is pruned out of the render.
  await expect(row(page, "a").first()).toBeVisible();
  await expect(row(page, "c").first()).toBeVisible();
  await expect(row(page, "b")).toHaveCount(0);

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(row(page, "b")).toBeVisible();
  await expect(
    page.getByRole("search", { name: "Filter", includeHidden: true }),
  ).toHaveCount(0);

  const subheader = page.locator('[aria-label="Active filters"]');
  await expect(subheader).toBeHidden();
});

test("inline tags fit their text in zoomed titles and regular nodes at every reading size", async ({
  page,
}) => {
  await seedOutline(page, [
    {
      id: "project",
      parentId: null,
      prevSiblingId: null,
      text: "Project #important",
    },
    {
      id: "child",
      parentId: "project",
      prevSiblingId: null,
      text: "A regular node #important",
    },
  ]);
  await openSeededOutline(page, { path: "/project", anchorId: "child" });
  const chips = page.locator('.node-text .tag[data-tag="important"]');
  await expect(chips).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);

  for (const size of ["small", "default", "large"]) {
    await page.evaluate((size) => {
      document.documentElement.dataset.textSize = size;
    }, size);
    const boxes = await chips.evaluateAll((els) =>
      els.map((el) => {
        const pill = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect();
        return {
          title: !!el.closest(".zoomed-title"),
          height: pill.height,
          topSpace: text.top - pill.top,
          bottomSpace: pill.bottom - text.bottom,
        };
      }),
    );
    for (const box of boxes) {
      // Text must fit inside the pill, not be cropped by its overflow mask.
      expect(
        box.topSpace,
        `${size}: space above tag text`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        box.bottomSpace,
        `${size}: space below tag text`,
      ).toBeGreaterThanOrEqual(0);
    }
    expect(boxes.find((box) => box.title)!.height).toBeGreaterThan(
      boxes.find((box) => !box.title)!.height,
    );
  }
});
