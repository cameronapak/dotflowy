import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  seedOutline,
  text,
  type SeedNode,
} from "./fixtures";

// alpha > alpha-1 > alpha-1-a, then bravo at the top level.
const TREE: SeedNode[] = [
  { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
  { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
  { id: "alpha-1", parentId: "alpha", prevSiblingId: null, text: "Alpha one" },
  {
    id: "alpha-1-a",
    parentId: "alpha-1",
    prevSiblingId: null,
    text: "Alpha one A",
  },
];

/** The row's guide layer: its painted width, and where each ancestor's bullet
 *  center sits, measured from the row's leading edge. */
function guides(page: Page, id: string) {
  return page.evaluate((id) => {
    const li = document.querySelector<HTMLElement>(`li[data-node-id="${id}"]`)!;
    const layer = getComputedStyle(li, "::before");
    const left = li.getBoundingClientRect().left;
    const axes: number[] = [];
    for (
      let parentId = li.dataset.parentId;
      parentId;
      parentId = document.querySelector<HTMLElement>(
        `li[data-node-id="${parentId}"]`,
      )!.dataset.parentId
    ) {
      const bullet = document
        .querySelector(`li[data-node-id="${parentId}"] > .outline-row .bullet`)!
        .getBoundingClientRect();
      axes.unshift(Math.round(bullet.left + bullet.width / 2 - left));
    }
    return {
      painted: layer.content !== "none",
      width: layer.width,
      axes,
    };
  }, id);
}

async function expectAlignedGuides(page: Page) {
  // One 24px-wide guide column per ancestor, each line 16px into its column,
  // which must land on that ancestor's bullet center.
  await expect
    .poll(() => guides(page, "alpha-1-a"))
    .toEqual({
      painted: true,
      width: "48px",
      axes: [16, 40],
    });
  await expect
    .poll(() => guides(page, "alpha-1"))
    .toEqual({
      painted: true,
      width: "24px",
      axes: [16],
    });
  // The next sibling at the top level ends alpha's line.
  expect((await guides(page, "bravo")).width).toBe("0px");
}

test("indent guides follow nesting and turn off from Settings", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "alpha-1-a" });
  await expectAlignedGuides(page);

  // A fine pointer puts the chevron on its parent's guide, centered on the
  // parent's bullet.
  await text(page, "alpha-1").hover();
  const offset = await page.evaluate(() => {
    const center = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return box.left + box.width / 2;
    };
    return (
      center('li[data-node-id="alpha-1"] .collapse-toggle svg') -
      center('li[data-node-id="alpha"] > .outline-row .bullet')
    );
  });
  expect(offset).toBe(0);

  // Indenting bravo under alpha gives it alpha's guide.
  await text(page, "bravo").click();
  await page.keyboard.press("Tab");
  await expect(page.locator('li[data-node-id="bravo"]')).toHaveAttribute(
    "data-parent-id",
    "alpha",
  );
  await expect
    .poll(async () => (await guides(page, "bravo")).width)
    .toBe("24px");

  await page.goto("/settings#appearance");
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  const toggle = page.getByRole("switch", { name: "Show indent guides" });
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();

  // The choice is an account preference, so it survives a fresh load.
  await openSeededOutline(page, { anchorId: "alpha-1-a" });
  await expect
    .poll(async () => (await guides(page, "alpha-1-a")).painted)
    .toBe(false);
});

test.describe("on a coarse pointer", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("indent guides stay on each ancestor's larger bullet", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await openSeededOutline(page, { anchorId: "alpha-1-a" });
    await expectAlignedGuides(page);
  });
});
