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
  await expect(text(page, "alpha")).toBeVisible({ timeout: 15_000 });
}

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByPlaceholder(/Search nodes and actions/)).toBeVisible();
}

test.describe("Cmd+K command center (ADR 0034)", () => {
  test("centers both the full menu and filtered results after a window resize", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await load(page);
    await text(page, "bravo").click();
    await openPalette(page);
    const dialog = page.getByRole("dialog", { name: "Command center" });
    const center = () =>
      dialog.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });

    await expect.poll(center).toBeCloseTo(360, 0);
    await page.getByPlaceholder(/Search nodes and actions/).fill("zephyr");
    await expect(page.getByRole("option", { name: /Zephyr/ })).toBeVisible();
    await expect.poll(center).toBeCloseTo(360, 0);
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(center).toBeCloseTo(450, 0);
  });

  test.describe("mobile", () => {
    test.use({ hasTouch: true, isMobile: true });

    test("centers within the visual viewport after keyboard resize and pan", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 412, height: 900 });
      await load(page);
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(true);
      await text(page, "bravo").click();
      await openPalette(page);
      const dialog = page.getByRole("dialog", { name: "Command center" });
      const center = () =>
        dialog.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.top + rect.height / 2;
        });

      await page.evaluate(() => {
        const vv = window.visualViewport!;
        Object.defineProperties(vv, {
          height: { configurable: true, value: 277 },
          offsetTop: { configurable: true, value: 103 },
        });
        vv.dispatchEvent(new Event("resize"));
      });
      await expect.poll(center).toBeCloseTo(241.5, 0); // 103 + 277 / 2
      const bounds = await dialog.boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(119); // visible top + 16px
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(364); // visible bottom - 16px
      const input = page.getByPlaceholder(/Search nodes and actions/);
      await expect(input).toBeFocused();
      const inputTop = (await input.boundingBox())!.y;
      const list = dialog.locator("[cmdk-list]");
      expect(
        await list.evaluate((el) => el.scrollHeight > el.clientHeight),
      ).toBe(true);
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const last = await dialog.getByRole("option").last().boundingBox();
      const listBounds = await list.boundingBox();
      expect(last!.y).toBeGreaterThanOrEqual(listBounds!.y);
      expect(last!.y + last!.height).toBeLessThanOrEqual(
        listBounds!.y + listBounds!.height + 1,
      );
      expect((await input.boundingBox())!.y).toBe(inputTop);

      await page.evaluate(() => {
        const vv = window.visualViewport!;
        Object.defineProperty(vv, "offsetTop", {
          configurable: true,
          value: 151,
        });
        vv.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(center).toBeCloseTo(289.5, 0); // 151 + 277 / 2

      await page.evaluate(() => {
        const vv = window.visualViewport!;
        Object.defineProperties(vv, {
          height: { configurable: true, value: 900 },
          offsetTop: { configurable: true, value: 0 },
        });
        vv.dispatchEvent(new Event("resize"));
      });
      await expect.poll(center).toBeCloseTo(450, 0);
    });
  });

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
