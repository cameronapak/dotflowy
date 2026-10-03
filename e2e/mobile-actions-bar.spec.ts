import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE } from "./fixtures";

// The mobile actions bar (ADR 0030) is a coarse-pointer, focus-gated toolbar. As
// in mobile-touch-rows.spec.ts, drive it in a Chromium mobile-emulation context
// so `(pointer: coarse)` actually matches -- the real signal the bar gates on,
// not a synthetic class. Geometry is tested with synthetic visualViewport
// changes. Real keyboard animation and iOS focus-preservation still require the
// manual iPhone checklist. Also covers focus/blur and each button's action wiring.

const bar = (page: Page) => page.locator("[data-mobile-bar]");
const btn = (page: Page, label: string) =>
  page.locator(`[data-mobile-bar] button[aria-label="${label}"]`);
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  // The first dev-server visit includes Vite's lazy module transforms.
  await expect(text(page, "alpha")).toBeVisible({ timeout: 15_000 });
}

// Focus `id` and drop the caret at absolute offset `col` (copied from
// enter-split.spec.ts: Home/Arrow keys are unreliable in macOS Chromium
// contentEditable, and a plain click lands past the text).
async function caretAt(page: Page, id: string, col: number) {
  await text(page, id).click();
  await text(page, id).evaluate((el, target) => {
    const sel = window.getSelection();
    if (!sel) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    const range = document.createRange();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
      node = walker.nextNode();
    }
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }, col);
}

test.describe("mobile actions bar (coarse pointer)", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 412, height: 900 },
  });

  test("mobile emulation actually reports a coarse pointer", async ({
    page,
  }) => {
    await load(page);
    const coarse = await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    );
    // If this fails the visibility assertions below would test the desktop path.
    expect(coarse).toBe(true);
  });

  test("hidden until a bullet is focused, shown while editing", async ({
    page,
  }) => {
    await load(page);
    // Nothing focused on load -> no bar.
    await expect(bar(page)).toHaveCount(0);
    await text(page, "alpha").click();
    await expect(bar(page)).toBeVisible();
  });

  test("fits the visible height and follows viewport panning without blocking editing", async ({
    page,
  }) => {
    await load(page);
    await text(page, "alpha").click();
    await expect(bar(page)).toBeVisible();

    // Shrink ONLY the visual viewport, as a keyboard does on current Chrome/iOS.
    // Resizing the browser window instead would miss the original failure mode.
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, "height", { configurable: true, value: 537 });
      vv.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(() => bar(page).evaluate((el) => el.getBoundingClientRect().bottom))
      .toBe(531); // 537px visible height minus the pill's existing 6px margin.

    // A scroll event changes the top edge without changing the visible height.
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, "offsetTop", {
        configurable: true,
        value: 103,
      });
      vv.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => bar(page).evaluate((el) => el.getBoundingClientRect().bottom))
      .toBe(634); // 103 + 537 - 6, not just height and not height minus offset.
    // The full-height positioning frame must not intercept taps on other nodes.
    await text(page, "alpha-2").click();
    await expect(text(page, "alpha-2")).toBeFocused();
    await btn(page, "Indent").click();
    await expect(text(page, "alpha-2")).toBeFocused();
    await expect(
      page.locator('li[data-node-id="alpha-2"][data-parent-id="alpha-1"]'),
    ).toBeVisible();

    // Closing the keyboard restores the original bottom anchor.
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, "height", { configurable: true, value: 900 });
      Object.defineProperty(vv, "offsetTop", { configurable: true, value: 0 });
      vv.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(() => bar(page).evaluate((el) => el.getBoundingClientRect().bottom))
      .toBe(894);
  });

  test("pinch zoom does not masquerade as a keyboard resize or pan", async ({
    page,
  }) => {
    await load(page);
    await text(page, "alpha").click();
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperties(vv, {
        height: { configurable: true, value: 300 },
        offsetTop: { configurable: true, value: 71 },
        scale: { configurable: true, value: 2 },
      });
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(
      await bar(page).evaluate((el) => el.getBoundingClientRect().bottom),
    ).toBe(894);
  });

  test("falls back to window resizing without the Visual Viewport API", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "visualViewport", { value: null });
    });
    await load(page);
    await text(page, "alpha").click();
    await expect(bar(page)).toBeVisible();
    await page.setViewportSize({ width: 412, height: 700 });
    await expect
      .poll(() => bar(page).evaluate((el) => el.getBoundingClientRect().bottom))
      .toBe(694);
  });

  test("indent then outdent restructure the focused bullet", async ({
    page,
  }) => {
    await load(page);
    // alpha-2 has a previous sibling (alpha-1), so it can indent under it.
    await text(page, "alpha-2").click();
    await btn(page, "Indent").click();
    await expect(
      page.locator('li[data-node-id="alpha-2"][data-parent-id="alpha-1"]'),
    ).toBeVisible();

    // Outdent walks it back out to a child of alpha.
    await btn(page, "Outdent").click();
    await expect(
      page.locator('li[data-node-id="alpha-2"][data-parent-id="alpha"]'),
    ).toBeVisible();
  });

  test("undo/redo replay the last structural edit", async ({ page }) => {
    await load(page);
    await text(page, "alpha-2").click();
    await btn(page, "Indent").click();
    const indented = page.locator(
      'li[data-node-id="alpha-2"][data-parent-id="alpha-1"]',
    );
    await expect(indented).toBeVisible();

    // Undo puts it back under alpha; redo re-applies the indent.
    await btn(page, "Undo indent").click();
    await expect(indented).toHaveCount(0);
    await expect(
      page.locator('li[data-node-id="alpha-2"][data-parent-id="alpha"]'),
    ).toBeVisible();

    await btn(page, "Redo indent").click();
    await expect(indented).toBeVisible();
  });

  test("complete toggles the focused bullet's completion", async ({ page }) => {
    await load(page);
    await text(page, "alpha").click();
    await expect(text(page, "alpha")).not.toHaveAttribute(
      "data-completed",
      "true",
    );
    await btn(page, "Toggle complete").click();
    await expect(text(page, "alpha")).toHaveAttribute("data-completed", "true");
    // Toggling again un-completes it (un-mark is always allowed).
    await btn(page, "Toggle complete").click();
    await expect(text(page, "alpha")).not.toHaveAttribute(
      "data-completed",
      "true",
    );
  });

  test("the slash button inserts / and opens the command menu", async ({
    page,
  }) => {
    await load(page);
    // Caret at the START so the inserted "/" is at offset 0 and detectSlash fires
    // (it triggers only when the "/" leads the line or follows whitespace).
    await caretAt(page, "alpha", 0);
    await btn(page, "Command menu").click();
    await expect(page.locator('[role="listbox"]')).toBeVisible();
  });

  test("blur hides the bar (system Done / back dismisses the keyboard)", async ({
    page,
  }) => {
    // There is no dismiss button (iOS's own Done / Android's back cover it, ADR
    // 0030); blurring the bullet is what hides the bar. Simulate the dismiss by
    // blurring the focused span directly.
    await load(page);
    await text(page, "alpha").click();
    await expect(bar(page)).toBeVisible();
    // SAFETY: text() selects the outline row's contentEditable HTML span.
    await text(page, "alpha").evaluate((el) => (el as HTMLElement).blur());
    await expect(bar(page)).toHaveCount(0);
  });
});

test.describe("mobile actions bar (fine pointer)", () => {
  test("never mounts on a fine pointer even while editing", async ({
    page,
  }) => {
    await load(page);
    await text(page, "alpha").click();
    await expect(text(page, "alpha")).toBeFocused();
    // Desktop pointer -> the bar is gated out entirely.
    await expect(bar(page)).toHaveCount(0);
  });
});
