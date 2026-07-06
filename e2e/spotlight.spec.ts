import { expect, test, type Page } from "@playwright/test";
import { seedOutline, STANDARD_TREE } from "./fixtures";

// A node's OWN editable text span and its content row (the element that dims).
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);

// Enable spotlight before any app script runs, so the toggle store's first
// snapshot is already `true` and the controller installs on mount.
async function loadWithSpotlight(page: Page, on: boolean) {
  await seedOutline(page, STANDARD_TREE);
  if (on) {
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:spotlight", "true");
    });
  }
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible();
}

// Spotlight focus mode (ADR 0033): the focused bullet + its ancestor chain stay
// full opacity; every other row dims to 0.3. Painted by a generated stylesheet
// keyed on data-node-id, gated by `spotlight-on` on <body>.
test.describe("spotlight focus mode", () => {
  test("focusing a nested bullet lights it and its ancestors, dims the rest", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);

    // Nothing focused yet -> mode is on but not dimming.
    await expect(page.locator("body")).not.toHaveClass(/spotlight-on/);

    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();
    await expect(page.locator("body")).toHaveClass(/spotlight-on/);

    // Focused node + its parent (the ancestor chain up to the root) stay full.
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "1");
    await expect(row(page, "alpha")).toHaveCSS("opacity", "1");

    // A sibling and an unrelated top-level node dim.
    await expect(row(page, "alpha-2")).toHaveCSS("opacity", "0.3");
    await expect(row(page, "bravo")).toHaveCSS("opacity", "0.3");
  });

  test("the lit set follows the caret to another bullet", async ({ page }) => {
    await loadWithSpotlight(page, true);

    await text(page, "alpha-1").click();
    await expect(row(page, "bravo")).toHaveCSS("opacity", "0.3");

    // Move to bravo (a top-level node, no ancestors): only bravo is lit now.
    await text(page, "bravo").click();
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
    await expect(row(page, "alpha")).toHaveCSS("opacity", "0.3");
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "0.3");
  });

  test("blurring the outline returns every row to full opacity", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);
    await text(page, "alpha-1").click();
    await expect(row(page, "bravo")).toHaveCSS("opacity", "0.3");

    // Nothing focused -> the `spotlight-on` class drops, so nothing is dimmed.
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await expect(page.locator("body")).not.toHaveClass(/spotlight-on/);
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
    await expect(row(page, "alpha")).toHaveCSS("opacity", "1");
  });

  test("with the mode off, focusing dims nothing", async ({ page }) => {
    await loadWithSpotlight(page, false);
    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();

    await expect(page.locator("body")).not.toHaveClass(/spotlight-on/);
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
  });
});
