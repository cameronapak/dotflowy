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

// Spotlight focus mode (ADR 0033): while a bullet is focused, every other row
// dims to 0.3 and ONLY the focused bullet stays full (single-node -- ancestors
// dim too). Pure CSS via `.spotlight-on:has(.node-text:focus)` + `:focus-within`.
test.describe("spotlight focus mode", () => {
  test("focusing a bullet lights only it and dims everything else", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);

    // Mode is on, but with no caret in the outline nothing dims (`:has` fails).
    await expect(row(page, "alpha")).toHaveCSS("opacity", "1");
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");

    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();

    // Only the focused bullet is full...
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "1");
    // ...its parent dims like everything else (single-node, no ancestor chain)...
    await expect(row(page, "alpha")).toHaveCSS("opacity", "0.3");
    // ...as do a sibling and an unrelated top-level node.
    await expect(row(page, "alpha-2")).toHaveCSS("opacity", "0.3");
    await expect(row(page, "bravo")).toHaveCSS("opacity", "0.3");
  });

  test("the lit bullet follows the caret", async ({ page }) => {
    await loadWithSpotlight(page, true);

    await text(page, "alpha-1").click();
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "1");
    await expect(row(page, "bravo")).toHaveCSS("opacity", "0.3");

    await text(page, "bravo").click();
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "0.3");
  });

  test("blurring the outline returns every row to full opacity", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);
    await text(page, "alpha-1").click();
    await expect(row(page, "bravo")).toHaveCSS("opacity", "0.3");

    // No caret -> `:has(.node-text:focus)` fails -> nothing is dimmed.
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "1");
  });

  test("zoomed in, the page title dims while a child bullet is focused", async ({
    page,
  }) => {
    await seedOutline(page, STANDARD_TREE);
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:spotlight", "true");
    });
    // Zoom into alpha: it now renders as the h2 page title, alpha-1 a child row.
    await page.goto("/alpha");
    const title = page.locator("h2.zoomed-title");
    const titleText = page.locator("h2.zoomed-title .node-text");
    await expect(titleText).toBeVisible();

    // Focus a child bullet -> the title dims like any parent, the child is full.
    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();
    await expect(title).toHaveCSS("opacity", "0.3");
    await expect(row(page, "alpha-1")).toHaveCSS("opacity", "1");

    // Focus the title itself -> it's the caret's node now, so it stays full.
    await titleText.click();
    await expect(titleText).toBeFocused();
    await expect(title).toHaveCSS("opacity", "1");
  });

  test("with the mode off, focusing dims nothing", async ({ page }) => {
    await loadWithSpotlight(page, false);
    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();

    await expect(page.locator("body")).not.toHaveClass(/spotlight-on/);
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
  });
});

// The header indicator (ADR 0033): a chip that is present ONLY while spotlight
// is on -- the passive at-rest awareness signal (the dim only shows while a
// caret is in the outline) AND the one-click off-switch. Its presence == the
// mode is active; clicking it turns the mode off, so the chip disappears.
test.describe("spotlight header indicator", () => {
  const indicator = (page: Page) =>
    page.locator("[data-spotlight-indicator]");

  test("is absent when spotlight is off", async ({ page }) => {
    await loadWithSpotlight(page, false);
    await expect(indicator(page)).toHaveCount(0);
  });

  test("is present at rest when spotlight is on (no caret needed)", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);
    // No bullet focused: the dim shows nothing, but the chip still signals on.
    await expect(indicator(page)).toBeVisible();
  });

  test("clicking it turns spotlight off: chip vanishes and dimming stops", async ({
    page,
  }) => {
    await loadWithSpotlight(page, true);
    await expect(indicator(page)).toBeVisible();

    // Turn the mode off from the header.
    await indicator(page).click();
    await expect(indicator(page)).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/spotlight-on/);

    // Focusing a bullet no longer dims its neighbors.
    await text(page, "alpha-1").click();
    await expect(text(page, "alpha-1")).toBeFocused();
    await expect(row(page, "bravo")).toHaveCSS("opacity", "1");
  });
});
