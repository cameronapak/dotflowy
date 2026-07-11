import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Sign-out must tear the page down with a FULL document navigation — the data
// layer is module singletons and the /api/sync socket authenticates only at
// upgrade, so an SPA-internal gate swap would leak the signed-out account's
// outline into the next sign-in (see signOutAndReload in src/lib/auth-client).
// These specs pin that contract: a marker stamped on `window` survives any
// SPA-internal swap but not a real navigation.

const TREE: SeedNode[] = [
  { id: "alpha", parentId: null, prevSiblingId: null, text: "alphabravo" },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __preNavMarker?: boolean }).__preNavMarker = true;
  });
}

async function clickSignOut(page: Page) {
  await page.getByRole("button", { name: /more/i }).click();
  await page.getByRole("menuitem", { name: /sign out/i }).click();
}

const hasMarker = (page: Page) =>
  page
    .evaluate(
      () =>
        (window as unknown as { __preNavMarker?: boolean }).__preNavMarker ===
        true,
    )
    // Mid-navigation the execution context is destroyed — that's the very
    // reload under test, not a failure; report "unknown" and let poll retry.
    .catch(() => null);

test.describe("Sign out (header More menu)", () => {
  test("a successful sign-out hard-navigates to / (new document, marker gone)", async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname === "/api/auth/sign-out",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        }),
    );
    await load(page);

    await clickSignOut(page);

    // The reload lands back on "/" and the fresh document has no marker — an
    // SPA-only gate swap would have kept it.
    await expect.poll(() => hasMarker(page)).toBe(false);
    await expect(page).toHaveURL("/");
    // The mocked get-session still answers, so the outline remounts fresh.
    await expect(text(page, "alpha")).toBeVisible();
  });

  test("a failed sign-out stays put and says so (no silent no-op)", async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname === "/api/auth/sign-out",
      (route) => route.fulfill({ status: 500, body: "nope" }),
    );
    await load(page);

    await clickSignOut(page);

    // No navigation: the session cookie is still valid and no teardown ran,
    // so the editor stays (same document — marker intact) and the failure is
    // surfaced instead of swallowed.
    await expect(page.getByText(/sign out failed/i)).toBeVisible();
    expect(await hasMarker(page)).toBe(true);
    await expect(text(page, "alpha")).toBeVisible();
  });
});
