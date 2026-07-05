import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// A collapsed parent with two children -- the child-count plugin (the first
// consumer of the `row:after-text` trailing decoration seam, ADR 0031) shows the
// hidden count, which lets us drive the budget -> overflow -> panel chain end to
// end. Space-free text so `toHaveText` comparisons are exact.
const SEED: SeedNode[] = [
  { id: "p", parentId: null, prevSiblingId: null, text: "parent", collapsed: true },
  { id: "c1", parentId: "p", prevSiblingId: null, text: "childone" },
  { id: "c2", parentId: "p", prevSiblingId: "c1", text: "childtwo" },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);
const chevron = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .collapse-toggle`);
// The trailing count badge in a row's decoration zone.
const count = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] .node-deco`).getByText("2", {
    exact: true,
  });

test.describe("node decoration budget: collapsed child-count (ADR 0031)", () => {
  test("a collapsed parent shows the hidden-child count; expanding removes it", async ({
    page,
  }) => {
    await seedOutline(page, SEED);
    await page.goto("/");
    await expect(row(page, "p")).toBeVisible();

    // Children are collapsed away, and the trailing zone shows their count.
    await expect(page.locator('li[data-node-id="c1"]')).toHaveCount(0);
    await expect(count(page, "p")).toBeVisible();

    // Expanding reveals the children and drops the count (the slot returns null
    // when the node isn't collapsed).
    await row(page, "p").hover();
    await chevron(page, "p").click();
    await expect(page.locator('li[data-node-id="c1"] .node-text')).toBeVisible();
    await expect(count(page, "p")).toHaveCount(0);
  });

  test("overflowing the budget reveals the affordance, which opens the detail panel", async ({
    page,
  }) => {
    await seedOutline(page, SEED);
    await page.goto("/");
    await expect(count(page, "p")).toBeVisible();

    // Force the budget tiny so even the single count overflows -- exercises the
    // CSS clip + the ResizeObserver overflow boolean without needing a wide
    // decoration.
    await page.addStyleTag({
      content: ":root{--node-deco-budget:4px !important;}",
    });

    // The overflow affordance appears (the boolean flipped)...
    const more = page.locator(`li[data-node-id="p"] .node-deco-more`);
    await expect(more).toBeVisible();

    // ...and opens the Tier-3 side panel showing the node's detail (its title +
    // the decorations that were clipped).
    await more.click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-slot="sheet-title"]')).toHaveText("parent");
  });
});
