import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

import { isE2eLunora, seedOutline, STANDARD_TREE } from "./fixtures";

/**
 * The stale-tab reload affordance (ADR 0046).
 *
 * A changelog cannot inform a client whose bundle is old, and that client is
 * exactly who a MAJOR bump exists for. The DO stamps `serverVersion` onto the
 * handshake frames; a mismatch against the bundle's own version raises a
 * persistent, non-blocking toast.
 *
 * This is a DISTINCT mechanism from the changelog dialog, and these specs keep
 * it honest about the three cases that matter: mismatch, match, and absent.
 */

const CURRENT: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const toast = (page: Page) => page.getByText("Dotflowy has been updated");

async function load(page: Page, serverVersion?: string) {
  await seedOutline(page, STANDARD_TREE, { serverVersion });
  await page.goto("/");
  await expect(page.locator('li[data-node-id="alpha"]')).toBeVisible();
}

test.describe("update available", () => {
  test("a newer server raises a reload toast", async ({ page }) => {
    test.skip(
      isE2eLunora(),
      "injects serverVersion through the classic sync handshake",
    );
    await load(page, "99.0.0");
    await expect(toast(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  });

  test("a matching server says nothing", async ({ page }) => {
    await load(page, CURRENT);
    await expect(page.locator('li[data-node-id="bravo"]')).toBeVisible();
    await expect(toast(page)).toHaveCount(0);
  });

  test("a frame without serverVersion says nothing -- absence is not staleness", async ({
    page,
  }) => {
    await load(page);
    await expect(page.locator('li[data-node-id="bravo"]')).toBeVisible();
    await expect(toast(page)).toHaveCount(0);
  });

  test("the toast does not block editing", async ({ page }) => {
    test.skip(
      isE2eLunora(),
      "injects serverVersion through the classic sync handshake",
    );
    await load(page, "99.0.0");
    await expect(toast(page)).toBeVisible();

    const alpha = page.locator('li[data-node-id="alpha"] .node-text').first();
    await alpha.click();
    await page.keyboard.type("!");
    await expect(alpha).toHaveText("Alpha!");
  });
});
