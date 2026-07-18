import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// The /settings page (#171): the home for plan & billing, account, connections,
// data, and appearance — and the reason the header More menu slimmed down.
//
// Stripe Checkout itself can't be driven here (it redirects off-origin), so
// these specs cover the SPA half: the free-plan state, the five sections, the
// navigation entry point, the slimmed menu, and the whole-outline Data export.
// `subscription.list()` is mocked to a free account (no rows).

const TREE: SeedNode[] = [
  { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
  { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
];

/** Mock the billing list endpoint as a FREE account (empty array). Registered
 *  after seedOutline so it wins (Playwright routes are last-registered-first). */
async function mockFreePlan(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/auth/subscription/list",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      }),
  );
}

interface CapturedDownload {
  filename: string;
  text: string;
}

declare global {
  interface Window {
    __downloads?: Promise<CapturedDownload>[];
  }
}

/** Shadow blob-anchor clicks so a download is captured in page, not saved. */
async function interceptDownloads(page: Page) {
  await page.addInitScript(() => {
    window.__downloads = [];
    const blobs = new Map<string, Blob>();
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      const url = origCreate(b);
      if (b instanceof Blob) blobs.set(url, b);
      return url;
    };
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const blob = blobs.get(this.href);
      if (!blob) return HTMLElement.prototype.click.call(this);
      const filename = this.download;
      window.__downloads!.push(
        blob.text().then((text) => ({ filename, text })),
      );
    };
  });
}

const nodeText = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

test.describe("Settings page", () => {
  test("More menu → Settings navigates to the settings page", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await mockFreePlan(page);
    await page.goto("/");
    await expect(nodeText(page, "alpha")).toBeVisible();

    await page.getByRole("button", { name: /more/i }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeVisible();
  });

  test("all five sections render", async ({ page }) => {
    await seedOutline(page, TREE);
    await mockFreePlan(page);
    await page.goto("/settings");

    for (const name of [
      "Plan & billing",
      "Account",
      "Connections",
      "Data",
      "Appearance",
    ]) {
      await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
    }
  });

  test("free plan shows the usage meter and all three upgrade CTAs", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await mockFreePlan(page);
    await page.goto("/settings");

    // Current-plan card reads "Free" and shows the usage meter.
    await expect(page.getByText("Current plan")).toBeVisible();
    await expect(page.getByText("Nodes used")).toBeVisible();

    // The three upgrade paths (unique CTA labels).
    await expect(
      page.getByRole("button", { name: "Upgrade monthly" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Upgrade yearly" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /founding member/i }),
    ).toBeVisible();

    // Honest founding copy — the auto-renewal must be disclosed (map rule).
    await expect(
      page.getByText(/Renews after 3 years unless you cancel/i),
    ).toBeVisible();
  });

  test("the free connections nudge points at Unlimited", async ({ page }) => {
    await seedOutline(page, TREE);
    await mockFreePlan(page);
    await page.goto("/settings");

    await expect(page.getByText(/Connecting AI apps requires/i)).toBeVisible();
  });

  test("Data → Export downloads the whole outline as OPML", async ({
    page,
  }) => {
    await interceptDownloads(page);
    await seedOutline(page, TREE);
    await mockFreePlan(page);
    // Load the outline first so the tree store is populated, then SPA-navigate
    // to /settings (the store survives the client-side route change).
    await page.goto("/");
    await expect(nodeText(page, "alpha")).toBeVisible();

    await page.getByRole("button", { name: /more/i }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);

    await page.getByRole("button", { name: "Export" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__downloads!.length))
      .toBeGreaterThan(0);
    const { filename, text } = await page.evaluate(() =>
      Promise.all(window.__downloads!).then((d) => d[0]!),
    );
    expect(filename).toMatch(/^dotflowy-export-\d{4}-\d{2}-\d{2}\.opml$/);
    expect(text).toContain('text="Alpha"');
    expect(text).toContain('text="Bravo"');
  });

  test("Appearance → theme segmented control switches to dark", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await mockFreePlan(page);
    await page.goto("/settings");

    await page
      .getByRole("radiogroup", { name: "Theme" })
      .getByRole("radio", { name: "Dark" })
      .click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("the More menu no longer holds the moved items", async ({ page }) => {
    await seedOutline(page, TREE);
    await mockFreePlan(page);
    await page.goto("/");
    await expect(nodeText(page, "alpha")).toBeVisible();

    await page.getByRole("button", { name: /more/i }).click();

    // Still present.
    await expect(
      page.getByRole("menuitem", { name: "Settings" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Sign out" }),
    ).toBeVisible();

    // Moved to /settings — gone from the menu.
    for (const gone of [
      /Copy as Markdown/,
      /Import OPML/,
      /Export OPML/,
      /Connect apps/,
      /^Theme$/,
      /Text size/,
      /Connect Google/,
      /Delete account/,
    ]) {
      await expect(page.getByRole("menuitem", { name: gone })).toHaveCount(0);
    }
  });
});
