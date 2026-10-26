import { expect, test } from "@playwright/test";

import { mockKeyboardViewport, seedOutline, text } from "./fixtures";

// Touch formatting (ADR 0069) in WebKit, iOS Safari's engine, with real taps:
// the bar's preventDefault-on-pointerdown must keep the selection alive across
// a tap so the toggle sees it. Chromium covers the rest in
// mobile-actions-bar.spec.ts; a real iPhone is still the final check.
test.use({
  browserName: "webkit",
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test.beforeEach(async ({ page }) => mockKeyboardViewport(page));

test("tapping Bold over a selection toggles it on and off", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
  ]);
  await page.goto("/");
  await expect(text(page, "n")).toBeVisible({ timeout: 20_000 });
  await text(page, "n").tap();
  await text(page, "n").evaluate((el) => {
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  });

  const bar = page.locator("[data-mobile-bar]");
  const bold = bar.getByRole("button", { name: "Bold", exact: true });
  await expect(bar).toHaveAttribute("data-mode", "format");
  await bold.tap();
  await expect(text(page, "n").locator("strong")).toHaveText("alphabravo");
  await expect(bold).toHaveAttribute("aria-pressed", "true");

  await bold.tap();
  await expect(text(page, "n").locator("strong")).toHaveCount(0);
  await expect(text(page, "n")).toHaveText("alphabravo");
});

// A plain autoFocus on the url field scrolled the page mid-entry in WebKit and
// stranded the sheet below the viewport (ADR 0069).
test("the link sheet settles on screen with the url focused", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "one" },
    { id: "b", parentId: null, prevSiblingId: "a", text: "two" },
    { id: "n", parentId: null, prevSiblingId: "b", text: "alphabravo" },
  ]);
  await page.goto("/");
  await expect(text(page, "n")).toBeVisible({ timeout: 20_000 });
  await text(page, "n").tap();
  await text(page, "n").evaluate((el) => {
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page
    .locator("[data-mobile-bar]")
    .getByRole("button", { name: "Link", exact: true })
    .tap();

  const url = page.locator(".sheet-surface").getByLabel("Link URL");
  await expect(url).toBeFocused();
  await expect
    .poll(() =>
      url.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
