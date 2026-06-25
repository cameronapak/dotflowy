import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .node-text`);

const directChildOf = (page: Page, parentId: string, nodeId: string) =>
  page.locator(
    `li[data-node-id="${parentId}"] ul.outline-children > li[data-node-id="${nodeId}"]`,
  );

/**
 *   - Uncle
 *       - existing
 *   - Parent
 *       - first
 *       - last
 *   - Aunt
 *       - cousin
 */
const TREE: SeedNode[] = [
  { id: "uncle", parentId: null, prevSiblingId: null, text: "Uncle" },
  { id: "parent", parentId: null, prevSiblingId: "uncle", text: "Parent" },
  { id: "aunt", parentId: null, prevSiblingId: "parent", text: "Aunt" },
  {
    id: "existing",
    parentId: "uncle",
    prevSiblingId: null,
    text: "existing",
  },
  { id: "first", parentId: "parent", prevSiblingId: null, text: "first" },
  { id: "last", parentId: "parent", prevSiblingId: "first", text: "last" },
  { id: "cousin", parentId: "aunt", prevSiblingId: null, text: "cousin" },
];

test.describe("keyboard move edge: reparent into parent's sibling", () => {
  test("move up at the top edge lands as the last child of the parent's previous sibling", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await page.goto("/");
    await text(page, "first").click();
    await page.keyboard.press(`${modifier()}+Shift+ArrowUp`);

    await expect(directChildOf(page, "uncle", "first")).toBeVisible();
    await expect(directChildOf(page, "parent", "first")).toHaveCount(0);
    await expect(
      directChildOf(page, "uncle", "first").locator("..").locator("> li").last(),
    ).toHaveAttribute("data-node-id", "first");
    await expect(text(page, "first")).toBeFocused();
  });

  test("move down at the bottom edge lands as the first child of the parent's next sibling", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await page.goto("/");
    await text(page, "last").click();
    await page.keyboard.press(`${modifier()}+Shift+ArrowDown`);

    await expect(directChildOf(page, "aunt", "last")).toBeVisible();
    await expect(directChildOf(page, "parent", "last")).toHaveCount(0);
    await expect(
      directChildOf(page, "aunt", "last").locator("..").locator("> li").first(),
    ).toHaveAttribute("data-node-id", "last");
    await expect(text(page, "last")).toBeFocused();
  });
});
