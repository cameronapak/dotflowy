import { expect, test, type Page } from "@playwright/test";
import { seedOutline, STANDARD_TREE } from "./fixtures";

const PRESET_KEY = "dotflowy:theme-preset";

const html = (page: Page) => page.locator("html");

async function load(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Color theme" }),
  ).toBeVisible();
}

async function pick(page: Page, label: string) {
  await page.getByRole("button", { name: "Color theme" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

test("picking a preset sets data-theme and persists it", async ({ page }) => {
  await load(page);

  // No preset chosen yet -> no attribute (styles.css :root/.dark is live).
  expect(await html(page).getAttribute("data-theme")).toBeNull();

  await pick(page, "Claude");
  await expect(html(page)).toHaveAttribute("data-theme", "claude");
  expect(await page.evaluate((k) => localStorage.getItem(k), PRESET_KEY)).toBe(
    "claude",
  );

  // Default clears the attribute (falls back to the built-in palette).
  await pick(page, "Default");
  expect(await html(page).getAttribute("data-theme")).toBeNull();
  expect(await page.evaluate((k) => localStorage.getItem(k), PRESET_KEY)).toBe(
    "default",
  );
});

test("a persisted preset is on <html> at first paint (no flash)", async ({
  page,
}) => {
  // Seed the preset before any app script runs, then load: the inline no-flash
  // script must have set the attribute by the time the editor is visible.
  await page.addInitScript(
    ([k, v]) => localStorage.setItem(k, v),
    [PRESET_KEY, "vercel"] as const,
  );
  await load(page);
  await expect(html(page)).toHaveAttribute("data-theme", "vercel");
});
