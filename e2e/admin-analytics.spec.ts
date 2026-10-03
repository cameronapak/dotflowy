import { expect, test, type Page } from "@playwright/test";

import type {
  AdminAnalyticsReport,
  AnalyticsUser,
} from "../src/data/admin-analytics-schema";

import { seedOutline } from "./fixtures";

test.use({ deviceScaleFactor: 2 });

const NOW = Date.UTC(2026, 9, 2, 12);
const users: AnalyticsUser[] = [
  {
    id: "a-owner",
    email: "owner@example.test",
    name: "Owner",
    emailVerified: true,
    createdAt: NOW,
    lastSessionCreatedAt: NOW,
    isOwner: true,
    experimentalPreference: "enabled",
    classicNodeCount: 500,
  },
  {
    id: "b-ada",
    email: "ada@example.test",
    name: "Ada",
    emailVerified: true,
    createdAt: NOW - 86_400_000,
    lastSessionCreatedAt: NOW,
    isOwner: false,
    experimentalPreference: "enabled",
    classicNodeCount: 12,
  },
  {
    id: "c-beau",
    email: "beau@example.test",
    name: "Beau",
    emailVerified: false,
    createdAt: NOW - 10 * 86_400_000,
    lastSessionCreatedAt: null,
    isOwner: false,
    experimentalPreference: "disabled",
    classicNodeCount: 0,
  },
  {
    id: "d-cleo",
    email: "cleo@example.test",
    name: "Cleo",
    emailVerified: true,
    createdAt: NOW - 60 * 86_400_000,
    lastSessionCreatedAt: null,
    isOwner: false,
    experimentalPreference: "unset",
    classicNodeCount: 5,
  },
  {
    id: "e-dev",
    email: "dev@example.test",
    name: "Dev",
    emailVerified: true,
    createdAt: NOW - 2 * 86_400_000,
    lastSessionCreatedAt: NOW - 9 * 86_400_000,
    isOwner: false,
    experimentalPreference: "unknown",
    classicNodeCount: null,
  },
];

function report(includeOwner = false, nextPage = false): AdminAnalyticsReport {
  return {
    generatedAt: NOW,
    includeOwner,
    ownerConfigured: true,
    activityCoverage: "not-installed",
    population: 6,
    summary: {
      registered: includeOwner ? 6 : 5,
      joined7d: includeOwner ? 3 : 2,
      joined30d: includeOwner ? 4 : 3,
      retainedSession7d: includeOwner ? 2 : 1,
      retainedSession30d: includeOwner ? 3 : 2,
    },
    users: nextPage
      ? [{ ...users[3]!, id: "z-final", email: "final@example.test" }]
      : users,
    nextCursor: nextPage ? null : "e-dev",
  };
}

async function setup(page: Page) {
  await seedOutline(page, [
    { id: "home", text: "Local fixture", parentId: null, prevSiblingId: null },
  ]);
}

function card(page: Page, title: string) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(title, { exact: true }) });
}

test("separates preference, data, and activity; owner toggle and cursor pages work", async ({
  page,
}, testInfo) => {
  await setup(page);
  let inspections = 0;
  await page.route("**/api/admin/analytics**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/storage")) {
      inspections++;
      await route.fulfill({
        json: {
          userId: "b-ada",
          checkedAt: NOW,
          metadata: { nodeCount: 18, nodesMigratedAt: NOW, kvMigratedAt: null },
        },
      });
    } else
      await route.fulfill({
        json: report(
          url.searchParams.get("includeOwner") === "true",
          !!url.searchParams.get("after"),
        ),
      });
  });
  await page.goto("/admin/analytics");
  await expect(
    page.getByRole("heading", { name: "Usage overview" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    card(page, "Registered users").getByText("5", { exact: true }),
  ).toBeVisible();
  await expect(
    card(page, "Experimental preference on").getByText("1", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Not measured", { exact: true })).toHaveCount(3);
  await expect(
    page.getByText(/Browser and MCP use classic sync/),
  ).toBeVisible();
  await expect(page.getByText(/not a current backend choice/)).toBeVisible();
  await expect(
    page.getByText("Unknown, read failed", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("row", { name: /beau@example.test/ }),
  ).toContainText("0 nodes");
  await expect(
    page.getByRole("row", { name: /cleo@example.test/ }),
  ).toContainText("Not set");
  expect(inspections).toBe(0);
  await page
    .getByRole("button", {
      name: "Inspect experimental storage for ada@example.test",
    })
    .click();
  await expect(
    page.getByRole("row", { name: /ada@example.test/ }),
  ).toContainText("18 nodes");
  expect(inspections).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("desktop.png"),
    fullPage: true,
  });
  await page.getByRole("checkbox", { name: "Include owner in totals" }).check();
  await expect(
    card(page, "Registered users").getByText("6", { exact: true }),
  ).toBeVisible();
  await expect(
    card(page, "Experimental preference on").getByText("2", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("row", { name: /final@example.test/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(
    page.getByRole("row", { name: /ada@example.test/ }),
  ).toBeVisible();
});

test("a failed reinspection removes stale counts instead of showing them as current", async ({
  page,
}) => {
  await setup(page);
  let read = 0;
  await page.route("**/api/admin/analytics**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/storage")) {
      await route.fulfill({
        json: {
          userId: "b-ada",
          checkedAt: NOW,
          metadata:
            ++read === 1
              ? { nodeCount: 18, nodesMigratedAt: null, kvMigratedAt: null }
              : null,
        },
      });
    } else await route.fulfill({ json: report() });
  });
  await page.goto("/admin/analytics");
  const row = page.getByRole("row", { name: /ada@example.test/ });
  const inspect = row.getByRole("button");
  await inspect.click();
  await expect(row).toContainText("18 nodes");
  await inspect.click();
  await expect(row).toContainText("Unknown, read failed");
  await expect(row).not.toContainText("18 nodes");
});

test("loading, errors, malformed success, and denied responses never display inventory", async ({
  page,
}, testInfo) => {
  await setup(page);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let response: "held" | "malformed" | "denied" = "held";
  await page.route("**/api/admin/analytics**", async (route) => {
    if (response === "held") {
      await held;
      await route.fulfill({ status: 500, json: { error: "failed" } });
    } else if (response === "malformed")
      await route.fulfill({
        json: { users: [{ email: "must-not-display@example.test" }] },
      });
    else await route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto("/admin/analytics");
  await expect(
    page.getByRole("status", { name: "Loading usage overview" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("loading.png") });
  release?.();
  await expect(
    page.getByText("Could not load the report", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("error.png") });
  response = "malformed";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("Could not load the report", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("must-not-display@example.test")).toHaveCount(0);
  response = "denied";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Not found.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Usage overview" }),
  ).toHaveCount(0);
});

test("empty population and missing owner configuration are explicit", async ({
  page,
}, testInfo) => {
  await setup(page);
  const empty = report();
  await page.route("**/api/admin/analytics**", (route) =>
    route.fulfill({
      json: {
        ...empty,
        ownerConfigured: false,
        population: 0,
        users: [],
        nextCursor: null,
        summary: {
          registered: 0,
          joined7d: 0,
          joined30d: 0,
          retainedSession7d: 0,
          retainedSession30d: 0,
        },
      },
    }),
  );
  await page.goto("/admin/analytics");
  await expect(
    page.getByText("No users on this page.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Owner identity is not configured. Totals include every account.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Include owner in totals" }),
  ).toBeDisabled();
  await expect(page.getByText("Not measured", { exact: true })).toHaveCount(3);
  await page.screenshot({
    path: testInfo.outputPath("empty.png"),
    fullPage: true,
  });
});

test("narrow layout contains the wide table without overflowing the page", async ({
  page,
}, testInfo) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/admin/analytics**", (route) =>
    route.fulfill({ json: report() }),
  );
  await page.goto("/admin/analytics");
  await expect(
    page.getByRole("row", { name: /ada@example.test/ }),
  ).toBeAttached();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
});

test("privacy states collection is off and requires an account choice", async ({
  page,
}, testInfo) => {
  await page.goto("/privacy");
  await expect(
    page.getByText("Activity reporting is not enabled.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /No collection will start for your account before you accept/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/No analytics, no ads, no trackers/)).toHaveCount(
    0,
  );
  await page.screenshot({
    path: testInfo.outputPath("privacy.png"),
    fullPage: true,
  });
});
