import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// A small nested tree: alpha has a subtree (for "Collapse all"), bravo is a
// sibling to indent under alpha, zephyr is a distinctive leaf whose text matches
// NO action keyword (so a query for it highlights the node result, not an
// action row -- the per-result `->` path needs the node highlighted).
//
//   Alpha (alpha)
//     Alpha one (alpha-1)
//       Alpha one deep (alpha-1-a)
//   Bravo (bravo)
//   Zephyr (zephyr)
const TREE: SeedNode[] = [
  { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
  { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
  { id: "zephyr", parentId: null, prevSiblingId: "bravo", text: "Zephyr" },
  { id: "alpha-1", parentId: "alpha", prevSiblingId: null, text: "Alpha one" },
  {
    id: "alpha-1-a",
    parentId: "alpha-1",
    prevSiblingId: null,
    text: "Alpha one deep",
  },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible();
}

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByPlaceholder(/Search nodes and actions/)).toBeVisible();
}

test.describe("Cmd+K command center (ADR 0034)", () => {
  test("ambient target: a focused bullet's actions run against it", async ({
    page,
  }) => {
    await load(page);
    // Focus Bravo -- the ambient target snapshot reads document.activeElement.
    await text(page, "bravo").click();
    await openPalette(page);

    // The ambient block names the target.
    await expect(page.getByText(/Acting on:\s*Bravo/)).toBeVisible();

    // Run "Indent": Bravo becomes a child of its previous sibling, Alpha.
    await page.getByRole("option", { name: /Indent/ }).click();

    await expect(page.locator('li[data-node-id="bravo"]')).toHaveAttribute(
      "data-parent-id",
      "alpha",
    );
  });

  test("per-result: -> opens a picked node's action sub-view", async ({
    page,
  }) => {
    await load(page);
    await openPalette(page); // opened from home -> no ambient block

    await page.keyboard.type("zephyr");
    await expect(page.getByRole("option", { name: /Zephyr/ })).toBeVisible();

    // Arrow-right on the highlighted node result drills into its actions.
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText(/Actions on:\s*Zephyr/)).toBeVisible();

    // Delete the node from the sub-view; its row disappears.
    await page.getByRole("option", { name: /Delete/ }).click();
    await expect(page.locator('li[data-node-id="zephyr"]')).toHaveCount(0);
  });

  test("global action: a More-menu action runs from the palette", async ({
    page,
  }) => {
    await load(page);
    await expect(text(page, "alpha-1")).toBeVisible();

    await openPalette(page);
    await page.keyboard.type("collapse all");
    await page.getByRole("option", { name: /Collapse all/ }).click();

    // The palette closed and the global "Collapse all" folded the subtree.
    await expect(text(page, "alpha-1")).toBeHidden();
    await expect(text(page, "alpha")).toBeVisible();
  });
});
