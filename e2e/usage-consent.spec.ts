import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import {
  USAGE_POLICY_VERSION,
  type UsageConsentState,
} from "../src/data/usage-consent-schema";
import { seedOutline } from "./fixtures";

test.use({ deviceScaleFactor: 2 });
const initial: UsageConsentState = {
  policyVersion: USAGE_POLICY_VERSION,
  choice: "unset",
  decidedAt: null,
  noticeAvailable: true,
  collectionInstalled: false,
};

async function setup(page: Page) {
  await seedOutline(page, [
    {
      id: "home",
      text: "You can keep writing without choosing",
      parentId: null,
      prevSiblingId: null,
    },
  ]);
  await page.route("**/api/auth/subscription/list", (route) =>
    route.fulfill({ json: [] }),
  );
}

test("advance notice is non-modal; acceptance and withdrawal sync with Settings without collecting", async ({
  page,
}, testInfo) => {
  await setup(page);
  let state = initial;
  const choices: unknown[] = [];
  const usageRequests: string[] = [];
  await page.route("**/api/usage/**", async (route) => {
    usageRequests.push(new URL(route.request().url()).pathname);
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      choices.push(body);
      state = { ...initial, choice: body.choice, decidedAt: 123 };
    }
    await route.fulfill({ json: state });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Optional usage reporting" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-node-id="home"] .node-text')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("notice.png") });
  await page.getByRole("button", { name: "Accept reporting" }).click();
  await expect(
    page.getByRole("heading", { name: "Optional usage reporting" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /more/i }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByText(/Accepted for policy 2026-10-02/)).toBeVisible();
  await expect(page.getByText(/Collection has not started/)).toBeVisible();
  await page
    .getByRole("button", { name: "Withdraw and delete summaries" })
    .click();
  await expect(
    page.getByText("Declined. Your activity summaries have been removed."),
  ).toBeVisible();
  expect(choices).toEqual([
    { policyVersion: USAGE_POLICY_VERSION, choice: "accepted" },
    { policyVersion: USAGE_POLICY_VERSION, choice: "declined" },
  ]);
  expect(new Set(usageRequests)).toEqual(new Set(["/api/usage/consent"]));
  await page.reload();
  await expect(
    page.getByText("Declined. Your activity summaries have been removed."),
  ).toBeVisible();
});

test("unpublished notice hides acceptance and does not interrupt the outline", async ({
  page,
}, testInfo) => {
  await setup(page);
  await page.route("**/api/usage/consent", (route) =>
    route.fulfill({ json: { ...initial, noticeAvailable: false } }),
  );
  await page.goto("/");
  await expect(page.locator('[data-node-id="home"] .node-text')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept reporting" }),
  ).toHaveCount(0);
  await page.goto("/settings");
  await expect(
    page.getByText(
      "The advance notice is not published yet. Acceptance is unavailable.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Decline reporting" }),
  ).toBeEnabled();
  await page
    .locator('[aria-label="Usage reporting"]')
    .screenshot({ path: testInfo.outputPath("unpublished.png") });
});

test("loading, read failure, and malformed success fail closed without blocking the app", async ({
  page,
}, testInfo) => {
  await setup(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mode: "held" | "malformed" | "ready" = "held";
  await page.route("**/api/usage/consent", async (route) => {
    if (mode === "held") {
      await held;
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
    } else if (mode === "malformed")
      await route.fulfill({ json: { choice: "accepted" } });
    else await route.fulfill({ json: initial });
  });
  await page.goto("/settings");
  await expect(page.getByText("Loading your choice…")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export usage data" }),
  ).toBeDisabled();
  await page
    .locator('[aria-label="Usage reporting"]')
    .screenshot({ path: testInfo.outputPath("loading.png") });
  release();
  await expect(page.getByRole("alert")).toContainText(
    "No acceptance or deletion is confirmed",
  );
  await page
    .locator('[aria-label="Usage reporting"]')
    .screenshot({ path: testInfo.outputPath("error.png") });
  mode = "malformed";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept reporting" }),
  ).toHaveCount(0);
  mode = "ready";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Accept reporting" }),
  ).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("failed withdrawal never reports erasure; pending write prevents duplicate taps", async ({
  page,
}, testInfo) => {
  await setup(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route("**/api/usage/consent", async (route) => {
    if (route.request().method() === "POST") {
      writes++;
      await held;
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
    } else
      await route.fulfill({
        json: { ...initial, choice: "accepted", decidedAt: 123 },
      });
  });
  await page.goto("/settings");
  const withdraw = page.getByRole("button", {
    name: "Withdraw and delete summaries",
  });
  await withdraw.click();
  await expect(withdraw).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Export usage data" }),
  ).toBeDisabled();
  expect(writes).toBe(1);
  release();
  await expect(page.getByRole("alert")).toContainText(
    "No acceptance or deletion is confirmed",
  );
  await expect(
    page.getByText("Declined. Your activity summaries have been removed."),
  ).toHaveCount(0);
  await expect(page.getByText(/Accepted for policy/)).toHaveCount(0);
  await page
    .locator('[aria-label="Usage reporting"]')
    .screenshot({ path: testInfo.outputPath("withdraw-error.png") });
});

test("narrow Settings presents equal explicit choices, privacy link, and downloadable usage export", async ({
  page,
}, testInfo) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const exported = { consent: null, daily: [] };
  await page.route("**/api/usage/**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/export") ? exported : initial,
    }),
  );
  await page.goto("/settings");
  await expect(
    page.getByRole("button", { name: "Accept reporting" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Decline reporting" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("link", { name: "Read the revised privacy policy" }),
  ).toHaveAttribute("href", "/privacy");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator('[aria-label="Usage reporting"]')
    .screenshot({ path: testInfo.outputPath("mobile.png") });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export usage data" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("dotflowy-usage-data.json");
  const path = await download.path();
  expect(path).not.toBeNull();
  if (!path) throw new Error("Missing export download");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(exported);
});
