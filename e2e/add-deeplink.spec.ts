import { expect, test, type Page } from "@playwright/test";
import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

async function load(page: Page, tree: SeedNode[] = STANDARD_TREE) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="alpha"] > .outline-row .node-text'),
  ).toBeVisible();
}

/** Client-nav so seedOutline's mock survives (a full reload re-runs the init). */
async function clientNavigate(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test.describe("/add deeplink", () => {
  test("creates under an explicit parent and lands with focus=last", async ({
    page,
  }) => {
    await load(page);

    await clientNavigate(page, "/add?text=Buymilk&parentId=alpha");

    // Redirected off /add into the parent zoom.
    await expect(page).not.toHaveURL(/\/add/);
    await expect(page).toHaveURL(/\/alpha/);
    await expect(page.locator("h2.zoomed-title .node-text")).toContainText(
      "Alpha",
    );

    // New last child under alpha, caret on it.
    const rows = page.locator("li[data-node-id] > .outline-row .node-text");
    await expect(rows.filter({ hasText: "Buymilk" })).toBeVisible();
    await expect(rows.filter({ hasText: "Buymilk" })).toBeFocused();
  });

  test("defaults to today's daily note when parentId is omitted", async ({
    page,
  }) => {
    await load(page);

    await clientNavigate(page, "/add?text=Quickcapture");

    await expect(page).not.toHaveURL(/\/add/);
    // Zoomed into a day note (not home, not /add).
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(page).not.toHaveURL(/\/$/);
    const year = String(new Date().getFullYear());
    await expect(page.locator("h2.zoomed-title .node-text")).toContainText(
      year,
    );

    const rows = page.locator("li[data-node-id] > .outline-row .node-text");
    await expect(rows.filter({ hasText: "Quickcapture" })).toBeVisible();
    await expect(rows.filter({ hasText: "Quickcapture" })).toBeFocused();
  });

  test("empty text bounces home with no new nodes", async ({ page }) => {
    await load(page);
    await clientNavigate(page, "/add?text=");
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.locator('li[data-node-id="alpha"] > .outline-row .node-text'),
    ).toBeVisible();
  });
});
