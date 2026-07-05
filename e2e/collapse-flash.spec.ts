import { expect, test, type Page } from "@playwright/test";
import { seedOutline, STANDARD_TREE } from "./fixtures";

// Cmd on macOS, Control elsewhere -- the e2e run is chromium on whatever host.
function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

// A node's OWN editable text span, its row, and its collapse chevron.
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);
const chevron = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .collapse-toggle`);

async function load(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible();
}

// The windowed list drops the reveal animation (ADR 0019), so a deliberate
// expand/collapse flashes the toggled row instead -- the same `.node-acted`
// pulse a move gives. Fired in the single `onToggleCollapsed` funnel, so it
// covers the chevron AND the Cmd+Up/Down hotkeys. See flash-node.ts.
test.describe("collapse flash: the toggled node pulses", () => {
  test("clicking the chevron collapses alpha and flashes its row", async ({
    page,
  }) => {
    await load(page);
    // alpha starts expanded (children visible).
    await expect(text(page, "alpha-1")).toBeVisible();

    // Hover so the gutter chevron is interactive, then collapse.
    await row(page, "alpha").hover();
    await chevron(page, "alpha").click();

    // The subtree is gone (instant, no slide) and the toggled row flashes...
    await expect(text(page, "alpha-1")).toBeHidden();
    const acted = row(page, "alpha");
    await expect(acted).toHaveClass(/node-acted/);
    await expect(
      acted.evaluate((el) => getComputedStyle(el).animationName),
    ).resolves.toBe("node-acted-fade");

    // ...while a sibling that wasn't toggled stays untinted.
    await expect(row(page, "bravo")).not.toHaveClass(/node-acted/);

    // The class clears itself on animationend so it can re-trigger.
    await expect(acted).not.toHaveClass(/node-acted/, { timeout: 4000 });
  });

  test("Cmd+Up (close) then Cmd+Down (open) each flash the toggled row", async ({
    page,
  }) => {
    await load(page);
    await text(page, "alpha").click();
    await expect(text(page, "alpha")).toBeFocused();

    // Close the open bullet -- children vanish, row flashes.
    await page.keyboard.press(`${modifier()}+ArrowUp`);
    await expect(text(page, "alpha-1")).toBeHidden();
    await expect(row(page, "alpha")).toHaveClass(/node-acted/);

    // Wait for the one-shot to clear so the reopen re-triggers a fresh flash.
    await expect(row(page, "alpha")).not.toHaveClass(/node-acted/, {
      timeout: 4000,
    });

    // Reopen -- children return, row flashes again.
    await page.keyboard.press(`${modifier()}+ArrowDown`);
    await expect(text(page, "alpha-1")).toBeVisible();
    await expect(row(page, "alpha")).toHaveClass(/node-acted/);
  });
});
