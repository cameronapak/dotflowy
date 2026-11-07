import { expect, test } from "@playwright/test";

import { openSeededOutline, seedOutline, STANDARD_TREE } from "./fixtures";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("mobile destinations, search, capture, and filter use existing app behavior", async ({
  page,
}) => {
  await seedOutline(page, STANDARD_TREE);
  await openSeededOutline(page, { anchorId: "alpha" });
  await expect(
    page.locator(".outline-header").getByText("Home", { exact: true }),
  ).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Outline navigation" });
  await expect(nav.getByRole("link")).toHaveCount(2);
  await expect(
    nav.getByRole("link", { name: "Home", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Search", exact: true }).tap();
  const search = page.getByRole("combobox");
  await search.fill("Alpha");
  await page
    .getByRole("option", { name: /Alpha/ })
    .first()
    .getByText("Alpha", { exact: true })
    .tap();
  await expect(page).toHaveURL(/\/alpha$/);
  await expect(nav.locator("[aria-current=page]")).toHaveCount(0);

  await nav.getByRole("link", { name: "Today", exact: true }).tap();
  await expect(
    nav.getByRole("link", { name: "Today", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const todayUrl = page.url();
  await nav.getByRole("link", { name: "Home", exact: true }).tap();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: "Quick add", exact: true }).tap();
  const capture = page.getByRole("textbox", { name: "Quick add", exact: true });
  await expect(capture).toBeFocused();
  await page.keyboard.insertText("Captured from the mobile toolbar");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Quick add", exact: true }),
  ).toBeHidden();
  await nav.getByRole("link", { name: "Today", exact: true }).tap();
  await expect(page).toHaveURL(todayUrl);
  await expect(
    page.locator("li[data-node-id] > .outline-row", {
      hasText: "Captured from the mobile toolbar",
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "View options", exact: true }).tap();
  await expect(page.locator(".menu-sheet-overlay")).toHaveAttribute(
    "data-expanded",
  );
  await expect
    .poll(() =>
      page
        .locator('.sheet-menu-content[role="dialog"]')
        .evaluate((el) => Math.round(el.getBoundingClientRect().bottom)),
    )
    .toBe(844);
  await page
    .getByRole("menuitem", { name: "Filter this view", exact: true })
    .tap();
  const filter = page.getByRole("combobox", { name: "Filter query" });
  await expect(filter).toBeFocused();
  await filter.fill("Captured");
  await expect(page).toHaveURL(/q=Captured/);
});

test("dock respects keyboard geometry, accessibility preferences, feature settings and desktop boundary", async ({
  page,
}) => {
  await seedOutline(page, STANDARD_TREE, {
    kv: {
      "account-prefs": [
        {
          key: "editor-feature:daily",
          value: { key: "editor-feature:daily", enabled: false },
        },
      ],
    },
  });
  await openSeededOutline(page, { anchorId: "alpha" });
  const nav = page.getByRole("navigation", { name: "Outline navigation" });
  await expect(nav.getByRole("link")).toHaveCount(1);
  for (const width of [320, 767]) {
    await page.setViewportSize({ width, height: 844 });
    const targets = await page
      .locator(".outline-header button, .mobile-navigation a")
      .evaluateAll((elements) =>
        elements.map((el) => {
          const { width, height, left, right } = el.getBoundingClientRect();
          return (
            width >= 44 && height >= 44 && left >= 0 && right <= innerWidth
          );
        }),
      );
    expect(targets.every(Boolean)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".mobile-navigation .lg-glass")).toHaveCount(0);
  await page.goto("/alpha");
  await expect(nav.locator("[aria-current=page]")).toHaveCount(0);
  const home = nav.getByRole("link", { name: "Home", exact: true });
  await home.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      value: innerHeight - 300,
    });
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(nav).toBeHidden();
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      value: innerHeight,
    });
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(nav).toBeVisible();
  await page.setViewportSize({ width: 768, height: 844 });
  await expect(nav).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Command center", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".outline-header")
      .getByRole("button", { name: "Quick add", exact: true }),
  ).toHaveCount(0);
});
