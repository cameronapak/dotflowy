import { expect, test, type Page } from "@playwright/test";

import { openSeededOutline, seedOutline, type SeedNode } from "./fixtures";

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
  await openSeededOutline(page, { anchorId: "alpha" });
  await expect(text(page, "alpha")).toBeVisible();
  await page.evaluate(() => {
    Object.assign(window, { __preNavMarker: true });
  });
}

async function clickSignOut(page: Page) {
  await page.getByRole("button", { name: /Account and help/ }).click();
  await page.getByRole("menuitem", { name: /sign out/i }).click();
}

const hasMarker = (page: Page) =>
  page
    .evaluate(
      () => "__preNavMarker" in window && window.__preNavMarker === true,
    )
    // Mid-navigation the execution context is destroyed — that's the very
    // reload under test, not a failure; report "unknown" and let poll retry.
    .catch(() => null);

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
  // The mocked get-session still answers, so the outline remounts fresh. This
  // is a whole new document on a dev server, so wait within the test budget
  // like openSeededOutline, not an interaction's 5s assertion budget.
  await text(page, "alpha").waitFor({ state: "visible" });
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

test("owner feedback loads once and session loss destroys its document without a sign-out click", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  let scriptLoads = 0;
  await page.route("https://ampcode.com/w/client_TestReview.js", (route) => {
    scriptLoads++;
    return route.fulfill({
      contentType: "text/javascript",
      body: "window.__feedbackTestLoaded = true;",
    });
  });
  await page.route("**/api/feedback-widget", (route) =>
    route.fulfill({
      json: { userId: "test-user", clientId: "client_TestReview" },
    }),
  );
  await page.route("**/api/auth-config", (route) =>
    route.fulfill({ json: { signupOpen: false, turnstileSiteKey: null } }),
  );
  await openSeededOutline(page, { anchorId: "alpha" });
  await page.evaluate(() => Object.assign(window, { __preNavMarker: true }));
  await expect
    .poll(() => page.evaluate(() => "__feedbackTestLoaded" in window))
    .toBe(true);
  // Ordinary SPA navigation must not request the script again.
  await page.getByRole("button", { name: /Account and help/ }).click();
  await page.getByRole("menuitem", { name: /^settings/i }).click();
  await expect(page).toHaveURL(/\/settings/);
  expect(scriptLoads).toBe(1);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: null }),
  );
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/get-session",
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await refreshed;
  await expect.poll(() => hasMarker(page)).toBe(false);
  await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
  expect(await page.evaluate(() => "__feedbackTestLoaded" in window)).toBe(
    false,
  );
  expect(scriptLoads).toBe(1);
});

test("denied, malformed and mismatched feedback config never loads a widget script", async ({
  page,
}) => {
  const scriptRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.resourceType() === "script" &&
      new URL(request.url()).hostname === "ampcode.com"
    )
      scriptRequests.push(request.url());
  });
  await seedOutline(page, TREE);
  for (const config of [
    null,
    { userId: "test-user", clientId: "client_../../evil" },
    { userId: "different-user", clientId: "client_TestReview" },
  ]) {
    await page.route("**/api/feedback-widget", (route) =>
      route.fulfill({
        status: config === null ? 404 : 200,
        json: config,
      }),
    );
    const response = page.waitForResponse("**/api/feedback-widget");
    await openSeededOutline(page, { anchorId: "alpha", path: "/?amp" });
    await (await response).finished();
    await expect(text(page, "alpha")).toBeVisible();
    expect(scriptRequests).toEqual([]);
    await expect(
      page.locator('script[src^="https://ampcode.com/w/"]'),
    ).toHaveCount(0);
  }
});
