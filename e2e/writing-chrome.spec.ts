import { expect, test } from "@playwright/test";

import {
  mockKeyboardViewport,
  openSeededOutline,
  placeCaret,
  seedOutline,
  STANDARD_TREE,
  text,
} from "./fixtures";

test("writing hides chrome without moving content; pointer and keyboard restore it", async ({
  page,
}) => {
  await seedOutline(page, STANDARD_TREE);
  await openSeededOutline(page, { anchorId: "alpha" });
  const chrome = page.locator(".outline-chrome");
  const addNode = page.getByRole("button", { name: "Add node", exact: true });
  const node = text(page, "alpha");
  await placeCaret(node, "end");
  await expect(chrome).toHaveCSS("opacity", "1");
  await expect(addNode).toHaveCSS("opacity", "1");
  const bounds = await node.boundingBox();
  await page.keyboard.type(" Writing");
  await expect(chrome).toHaveCSS("opacity", "0");
  await expect(addNode).toHaveCSS("opacity", "0");
  await expect(addNode).toHaveCSS("pointer-events", "none");
  await expect(node).toBeFocused();
  expect(await node.boundingBox()).toEqual(bounds);
  await expect(node).toContainText("Alpha Writing");

  await page.mouse.move(600, 300);
  await expect(chrome).toHaveCSS("opacity", "1");
  await expect(addNode).toHaveCSS("opacity", "1");
  await expect(addNode).toHaveCSS("pointer-events", "auto");
  await page.keyboard.type(" again");
  await expect(chrome).toHaveCSS("opacity", "0");
  await page.mouse.wheel(0, 20);
  await expect(chrome).toHaveCSS("opacity", "1");
  await page.keyboard.type(".");
  await expect(chrome).toHaveCSS("opacity", "0");
  await page.keyboard.press("Escape");
  await expect(chrome).toHaveCSS("opacity", "1");

  await placeCaret(node, "end");
  await page.keyboard.type(".");
  await expect(chrome).toHaveCSS("opacity", "0");
  // Shift+Tab exits the first editable toward the header, without a mouse.
  await page.keyboard.press("Shift+Tab");
  await expect(chrome).toHaveCSS("opacity", "1");
  await expect(addNode).toHaveCSS("opacity", "1");

  await page
    .getByRole("button", { name: "Filter this view", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Filter query" }).fill("Alpha");
  await expect(chrome).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
});

test("writing in a zoomed title hides chrome; header focus restores it", async ({
  page,
}) => {
  await seedOutline(page, STANDARD_TREE);
  await openSeededOutline(page, { path: "/alpha", anchorId: "alpha-1" });
  const chrome = page.locator(".outline-chrome");
  const title = page.locator(".zoomed-title .node-text");
  await placeCaret(title, "end");
  await page.keyboard.type(" title");
  await expect(chrome).toHaveCSS("opacity", "0");
  await page.getByRole("button", { name: "View options", exact: true }).focus();
  await expect(chrome).toHaveCSS("opacity", "1");
});

test.describe("touch writing with Spotlight", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("tap restores chrome; editing keeps its toolbar and respects reduced motion", async ({
    page,
  }) => {
    await mockKeyboardViewport(page);
    await seedOutline(page, STANDARD_TREE);
    await page.addInitScript(() => {
      localStorage.setItem("dotflowy:spotlight", "true");
    });
    await openSeededOutline(page, { anchorId: "alpha" });
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const chrome = page.locator(".outline-chrome");
    const addNode = page.getByRole("button", { name: "Add node", exact: true });
    const node = text(page, "alpha");
    await node.tap();
    await page.keyboard.type(" Writing");
    await expect(chrome).toHaveCSS("opacity", "0");
    await expect(addNode).toHaveCSS("opacity", "0");
    await expect(node).toBeFocused();
    await expect(
      page.getByRole("toolbar", { name: "Editing actions" }),
    ).toBeVisible();

    await page.touchscreen.tap(15, 20);
    await expect(chrome).toHaveCSS("opacity", "1");
    await expect(addNode).toHaveCSS("opacity", "1");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await placeCaret(node, "end");
    await page.keyboard.type(".");
    await expect(chrome).toHaveCSS("opacity", "0");
    await expect(addNode).toHaveCSS("opacity", "0");
    await expect(chrome).toHaveCSS("transition-property", "none");
    await expect(addNode).toHaveCSS("transition-property", "none");
    await page.keyboard.press("Escape");
    await expect(chrome).toHaveCSS("opacity", "1");
  });
});
