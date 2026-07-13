import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE } from "./fixtures";

// Cmd on macOS, Control elsewhere (mirrors daily-notes.spec.ts).
function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

const dialog = (page: Page) =>
  page.locator('[role="dialog"][aria-label="Quick add"]');
const editor = (page: Page) =>
  page.locator(".quick-add-editor [contenteditable]");
const destChip = (page: Page) => page.locator("[data-quick-add-dest]");
const todayButton = (page: Page) =>
  page.getByRole("button", { name: "Today's daily note" });
const rowWithText = (page: Page, t: string) =>
  page.locator("li[data-node-id] > .outline-row", { hasText: t });

async function load(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="alpha"] > .outline-row .node-text'),
  ).toBeVisible();
}

/** Open quick-add via the global Opt+Cmd+N hotkey, then wait for the destination
 *  to resolve to Today (a kv get-or-create round-trip) before returning -- typing
 *  before it settles would race the born-in-destination decision. */
async function openQuickAdd(page: Page) {
  await page.keyboard.press("Alt+Meta+KeyN");
  await expect(dialog(page)).toBeVisible();
  await expect(destChip(page)).toHaveAttribute("data-quick-add-dest", "Today");
  await editor(page).click();
}

async function type(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.type(text);
}

test.describe("quick-add capture", () => {
  test("Opt+Cmd+N opens the overlay and Esc closes it", async ({ page }) => {
    await load(page);
    await page.keyboard.press("Alt+Meta+KeyN");
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
  });

  test("rapid-fire Enter commits each capture as a sibling at the bottom of Today", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await type(page, "first-capture");
    await page.keyboard.press("Enter");
    await type(page, "second-capture");
    await page.keyboard.press("Enter");

    // The running session list proves both landed without peeking at Today.
    await expect(dialog(page)).toContainText("first-capture");
    await expect(dialog(page)).toContainText("second-capture");

    // Close, then open Today and confirm both are children, in capture order.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);

    const firstRow = rowWithText(page, "first-capture");
    const secondRow = rowWithText(page, "second-capture");
    // Capture -> Today get-or-create -> WS echo -> nav is a longer async chain
    // than a synchronous outline edit, so allow for it under parallel contention.
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await expect(secondRow).toBeVisible({ timeout: 10_000 });

    // first-capture precedes second-capture (chronological log).
    const firstIdx = await firstRow.evaluate((el) => {
      const rows = Array.from(document.querySelectorAll("li[data-node-id]"));
      return rows.indexOf(el.closest("li[data-node-id]")!);
    });
    const secondIdx = await secondRow.evaluate((el) => {
      const rows = Array.from(document.querySelectorAll("li[data-node-id]"));
      return rows.indexOf(el.closest("li[data-node-id]")!);
    });
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  test("open + abandon (no keystroke) leaves no today note (lazy resolve)", async ({
    page,
  }) => {
    await load(page);
    await page.keyboard.press("Alt+Meta+KeyN");
    await expect(dialog(page)).toBeVisible();
    // The chip reads Today immediately (label is known without creating anything).
    await expect(destChip(page)).toHaveAttribute(
      "data-quick-add-dest",
      "Today",
    );
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    // Nothing was typed, so today's note was never minted -- no Daily container.
    await expect(rowWithText(page, "Daily")).toHaveCount(0);
  });

  test("the FAB never mounts on a fine pointer", async ({ page }) => {
    await load(page);
    await expect(page.locator("[data-quick-add-fab]")).toHaveCount(0);
  });

  test("discard-if-empty: a typed-then-cleared capture leaves nothing", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await type(page, "ephemeral");
    // Clear it back to empty, then close.
    await page.keyboard.press(`${modifier()}+a`);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();

    // Open Today: the cleared capture must not be there.
    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(rowWithText(page, "ephemeral")).toHaveCount(0);
  });

  test("a captured node survives closing (commit-immediately)", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);
    await type(page, "kept-on-close");
    // No Enter -- just close. A non-empty draft is already live in Today.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();

    await todayButton(page).click();
    await expect(rowWithText(page, "kept-on-close")).toBeVisible();
  });

  test("the Today chip retargets the current capture", async ({ page }) => {
    await load(page);
    await openQuickAdd(page);
    await type(page, "moved-capture");

    // Open the retarget picker and choose Bravo.
    await destChip(page).click();
    const picker = page.getByPlaceholder("Capture into…");
    await expect(picker).toBeVisible();
    await picker.fill("Bravo");
    await page.getByRole("option", { name: "Bravo" }).click();

    // The chip now reads Bravo, and the node lives under Bravo (not Today).
    await expect(destChip(page)).toHaveAttribute(
      "data-quick-add-dest",
      "Bravo",
    );
    await page.keyboard.press("Escape");

    const moved = rowWithText(page, "moved-capture");
    await expect(moved).toBeVisible();
    const parentId = await moved.evaluate(
      (el) =>
        el.closest("li[data-node-id]")?.getAttribute("data-parent-id") ?? null,
    );
    expect(parentId).toBe("bravo");
  });

  test("tags and the slash palette work inside the mini-editor", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    // A #tag folds into a chip live while composing.
    await type(page, "read #books");
    await expect(dialog(page).locator('.tag[data-tag="books"]')).toBeVisible();

    // "/" opens the curated command palette; the structural verbs are absent.
    await page.keyboard.type(" /");
    const palette = page.getByRole("listbox");
    await expect(palette).toBeVisible();
    await expect(palette).toContainText("Paragraph");
    await expect(palette).not.toContainText("Move");
    await expect(palette).not.toContainText("Delete");
  });
});

// The FAB is a coarse-pointer surface (ADR 0030's presence seam), so drive it in
// Chromium mobile emulation where `(pointer: coarse)` actually matches. The
// keyboard-anchored overlay positioning (visualViewport) is NOT exercisable here
// (no real software keyboard) -- that's the PR's manual iPhone checklist. This
// covers the FAB's mount gating: coarse-only, and its not-editing visibility.
test.describe("quick-add mobile FAB (coarse pointer)", () => {
  test.use({ hasTouch: true, isMobile: true });

  const fab = (page: Page) => page.locator("[data-quick-add-fab]");

  test("mobile emulation actually reports a coarse pointer", async ({
    page,
  }) => {
    await load(page);
    const coarse = await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    );
    expect(coarse).toBe(true);
  });

  test("mounts when not editing and opens the overlay on tap", async ({
    page,
  }) => {
    await load(page);
    await expect(fab(page)).toBeVisible();
    await fab(page).tap();
    await expect(dialog(page)).toBeVisible();
  });

  test("is hidden while a bullet is being edited (complement of the mobile bar)", async ({
    page,
  }) => {
    await load(page);
    await expect(fab(page)).toBeVisible();
    // Focus a bullet -> editing -> the FAB yields to the mobile actions bar.
    const bullet = page.locator(
      'li[data-node-id="alpha"] > .outline-row .node-text',
    );
    await bullet.tap();
    await expect(bullet).toBeFocused();
    await expect(fab(page)).toBeHidden();
    // Blur back out -> the FAB returns.
    await bullet.evaluate((el) => (el as HTMLElement).blur());
    await expect(fab(page)).toBeVisible();
  });
});
