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

test("View bookmarks the current page on desktop and removes it in the narrow sheet", async ({
  page,
}) => {
  await load(page);
  const view = page.getByRole("button", { name: "View options" });
  const bookmark = page.getByRole("menuitemcheckbox", {
    name: "Bookmark this page",
    exact: true,
  });
  await view.click();
  await expect(bookmark).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto("/alpha");
  // Page readiness uses the test budget, not the 5s interaction assertion budget.
  await page
    .locator("h2.zoomed-title .node-text")
    .waitFor({ state: "visible" });
  await view.click();
  await expect(bookmark).toHaveAttribute("aria-checked", "false");
  await bookmark.click();
  await expect(bookmark).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await openPalette(page);
  await expect(page.getByRole("option", { name: /Alpha/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.reload();
  await page
    .locator("h2.zoomed-title .node-text")
    .waitFor({ state: "visible" });
  await page.setViewportSize({ width: 390, height: 844 });
  await view.click();
  await expect(
    page.getByRole("dialog", { name: "View options" }),
  ).toBeVisible();
  await expect(page.locator(".menu-sheet-overlay")).toHaveAttribute(
    "data-expanded",
  );
  await expect(bookmark).toHaveAttribute("aria-checked", "true");
  await bookmark.click();
  await expect(bookmark).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await openPalette(page);
  await expect(
    page.getByText("No bookmarks yet.", { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/");
  await text(page, "alpha").waitFor({ state: "visible" });
  await view.click();
  await expect(
    page.getByRole("dialog", { name: "View options" }),
  ).toBeVisible();
  await expect(bookmark).toHaveCount(0);
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
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
      true,
    );
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
  await openPalette(page);
  await page.keyboard.press("Escape");
  // Reopening must read edits made while the closed palette skips its scan.
  await text(page, "zephyr").fill("Kestrel");
  await openPalette(page);

  await page.keyboard.type("kestrel");
  await expect(page.getByRole("option", { name: /Kestrel/ })).toBeVisible();

  // Arrow-right on the highlighted node result drills into its actions.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(/Actions on:\s*Kestrel/)).toBeVisible();

  // Delete the node from the sub-view; its row disappears.
  await page.getByRole("option", { name: /Delete/ }).click();
  await expect(page.locator('li[data-node-id="zephyr"]')).toHaveCount(0);
});

test("Scribble mode covers active text, tokens, titles, and Quick-add without changing source", async ({
  page,
}) => {
  const source =
    "Draft **bold** `code` #focus [link](https://example.com) John 3:16 ||spoiler||";
  await seedOutline(
    page,
    TREE.map((node) =>
      node.id === "alpha" ? { ...node, text: source } : node,
    ),
  );
  await page.goto("/");
  const row = text(page, "alpha");
  await expect(row).toBeVisible({ timeout: 15000 });
  await openPalette(page);
  await page.getByPlaceholder(/Search nodes and actions/).fill("scribble");
  await page.getByRole("option", { name: /Turn on Scribble mode/ }).click();
  const off = page.getByRole("button", {
    name: "Turn off Scribble mode",
    exact: true,
  });
  await expect(off).toBeVisible();
  await expect(row).toHaveCSS("font-family", '"Redacted Script"');
  expect(
    await page.evaluate(
      async () => (await document.fonts.load('17px "Redacted Script"')).length,
    ),
  ).toBeGreaterThan(0);
  // Code and React widget text must not escape the font through their own styles.
  await expect(row.locator("code")).toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await expect(row.locator("[data-bible-ref]")).toBeVisible();
  await expect(row.locator("[data-bible-ref] span").first()).toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await text(page, "bravo").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" writing");
  await expect(text(page, "bravo")).toBeFocused();
  await expect(text(page, "bravo")).toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("!");
  await expect(text(page, "bravo")).toHaveText("Bravo writin!g");
  await openPalette(page);
  await page
    .getByPlaceholder(/Search nodes and actions/)
    .fill("Spotlight mode");
  await page.getByRole("option", { name: /Spotlight mode/ }).click();
  await text(page, "bravo").click();
  await expect(text(page, "bravo")).toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await expect(
    page.getByRole("button", { name: "Turn off spotlight mode" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Turn off spotlight mode" }).click();
  await page.reload();
  // The document loads before the lazy editor; check persistence once it mounts.
  await row.waitFor({ state: "visible" });
  await expect(off).toBeVisible();
  await expect(text(page, "bravo")).toHaveText("Bravo writin!g");
  await expect(row).toHaveCSS("font-family", '"Redacted Script"');
  expect(
    await page.evaluate(async () => (await fetch("/api/nodes")).json()),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "alpha", text: source }),
    ]),
  );

  await page.goto("/alpha");
  const title = page.locator("h2.zoomed-title .node-text");
  await title.waitFor({ state: "visible" });
  await expect(title).toHaveCSS("font-family", '"Redacted Script"');
  await expect(page.locator("header")).not.toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await openPalette(page);
  await page.getByPlaceholder(/Search nodes and actions/).fill("quick add");
  await page.getByRole("option", { name: /Quick add/ }).click();
  const capture = page.getByRole("textbox", { name: "Quick add", exact: true });
  await expect(capture).toBeFocused();
  await page.keyboard.type("A new thought");
  await expect(capture).toHaveCSS("font-family", '"Redacted Script"');
  await page.keyboard.press("Escape");
  await off.click();
  await expect(title).not.toHaveCSS("font-family", '"Redacted Script"');
  await expect(off).toHaveCount(0);

  await page.getByRole("button", { name: "View options" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Scribble mode", exact: true })
    .click();
  await expect(off).toBeVisible();
  await page.keyboard.press("Escape");
  await openPalette(page);
  await page.getByPlaceholder(/Search nodes and actions/).fill("scribble");
  await page.getByRole("option", { name: /Turn off Scribble mode/ }).click();
  await expect(title).not.toHaveCSS("font-family", '"Redacted Script"');
});
