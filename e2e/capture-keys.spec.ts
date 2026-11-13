import { expect, test, type Page } from "@playwright/test";

import { seedOutline } from "./fixtures";

interface RequestRecord {
  method: string;
  body: unknown;
}

test("serves the signed Dotflowy file at its installation path", async ({
  request,
}) => {
  const response = await request.get("/shortcuts/Dotflowy.shortcut");
  expect(response.ok()).toBe(true);
  expect((await response.body()).subarray(0, 4).toString()).toBe("AEA1");
});

async function mountDialog(page: Page) {
  await seedOutline(page, []);
  await page.route(
    (url) => url.pathname === "/api/auth/subscription/list",
    (route) => route.fulfill({ json: [] }),
  );
  await page.goto("/settings");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
}

test("API keys select permissions and expiry, reveal once, copy, and clear on close", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const secret = "dfc_" + "a".repeat(64);
  const requests: RequestRecord[] = [];
  await page.route("**/api/keys", async (route) => {
    const request = route.request();
    requests.push({ method: request.method(), body: request.postDataJSON() });
    if (request.method() === "GET") {
      return route.fulfill({ json: { keys: [] } });
    }
    return route.fulfill({
      json: {
        key: secret,
        entry: {
          id: "key-1",
          name: "My iPhone",
          suffix: "c123",
          createdAt: Date.UTC(2026, 0, 2),
          lastUsedAt: null,
          expiresAt: Date.UTC(2099, 0, 2),
          permission: request.postDataJSON().permission,
        },
      },
    });
  });

  await mountDialog(page);
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("No API keys yet.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Capture only", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "30 days", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  for (const name of ["Capture only", "Read-only", "Read and write"]) {
    await expect
      .poll(() =>
        page
          .getByRole("button", { name, exact: true })
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
  }
  await page.getByRole("button", { name: "Read-only", exact: true }).click();
  await expect(
    page.getByText(/Read, search, and export through MCP/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Read and write", exact: true })
    .click();
  await expect(
    page.getByText(/Can edit and delete your outline/),
  ).toBeVisible();
  await page.getByLabel("Name").fill("My iPhone");
  await page.getByRole("button", { name: "90 days", exact: true }).click();
  await page.getByRole("button", { name: "Create key" }).click();

  await expect(page.getByLabel("New API key")).toHaveValue(secret);
  const dialog = page.getByRole("dialog");
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  const copy = page.getByRole("button", { name: "Copy", exact: true });
  await expect
    .poll(async () => {
      const copyBounds = await copy.boundingBox();
      return copyBounds!.x + copyBounds!.width;
    })
    .toBeLessThanOrEqual(390);
  expect(requests.at(-1)).toEqual({
    method: "POST",
    body: { name: "My iPhone", expiry: "90d", permission: "write" },
  });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(secret);

  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(page.getByLabel("New API key")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "30 days", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Name").fill("Read-only CLI");
  await page.getByRole("button", { name: "Read-only", exact: true }).click();
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByLabel("New API key")).toHaveValue(secret);
  expect(requests.at(-1)).toEqual({
    method: "POST",
    body: { name: "Read-only CLI", expiry: "30d", permission: "read" },
  });
});

test("API keys retry failures, rotate with confirmation, and revoke", async ({
  page,
}) => {
  let gets = 0;
  const deletes: unknown[] = [];
  const rotations: unknown[] = [];
  let releaseRotation!: () => void;
  const pendingRotation = new Promise<void>((resolve) => {
    releaseRotation = resolve;
  });
  const replacementSecret = "dfk_" + "c".repeat(64);
  const keys = [
    {
      id: "phone",
      name: "Phone",
      suffix: "1111",
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: Date.UTC(2099, 0, 2),
      permission: "capture",
    },
    {
      id: "tablet",
      name: "Tablet",
      suffix: "2222",
      createdAt: 2,
      lastUsedAt: 3,
      expiresAt: 4,
      permission: "read",
    },
  ];
  await page.route("**/api/keys", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      gets += 1;
      if (gets === 1)
        return route.fulfill({
          status: 503,
          json: { error: "unavailable", message: "Try later" },
        });
      return route.fulfill({ json: { keys } });
    }
    if (request.method() === "PATCH") {
      rotations.push(request.postDataJSON());
      if (rotations.length === 1) return route.abort("failed");
      await pendingRotation;
      return route.fulfill({
        json: { key: replacementSecret, entry: keys[0] },
      });
    }
    deletes.push(request.postDataJSON());
    return route.fulfill({ json: { revoked: true } });
  });

  await mountDialog(page);
  await expect(page.getByRole("alert")).toHaveText("Try later");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Phone", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Phone" }),
  ).toContainText("Capture only · Expires");
  await expect(
    page.getByRole("listitem").filter({ hasText: "Tablet" }),
  ).toContainText("Read-only · Expired");

  await page.getByRole("button", { name: "Rotate Phone" }).click();
  expect(rotations).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(rotations).toHaveLength(0);
  await page.getByRole("button", { name: "Rotate Phone" }).click();
  const expiryGroup = page.getByRole("group", {
    name: "Replacement expiration",
  });
  await expiryGroup
    .getByRole("button", { name: "90 days", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm rotation" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Rotation may have completed. Rotate again to get a new key",
  );
  await page.getByRole("button", { name: "Confirm rotation" }).click();
  await expect.poll(() => rotations.length).toBe(2);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  releaseRotation();
  await expect(page.getByLabel("New API key")).toHaveValue(replacementSecret);
  expect(rotations).toEqual([
    { id: "phone", expiry: "90d" },
    { id: "phone", expiry: "90d" },
  ]);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(page.getByLabel("New API key")).toHaveCount(0);
  await page.getByRole("button", { name: "Revoke Phone" }).click();
  await page
    .getByRole("button", { name: "Confirm revoke", exact: true })
    .click();
  await expect(page.getByText("Phone", { exact: true })).toHaveCount(0);
  expect(deletes[0]).toEqual({ id: "phone" });

  await page.getByRole("button", { name: "Revoke all" }).click();
  await page.getByRole("button", { name: "Confirm revoke all" }).click();
  await expect(page.getByText("No API keys yet.")).toBeVisible();
  expect(deletes[1]).toEqual({});
});

test("Settings opens focused Apple Shortcut setup with manual copy and a separate manager", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedOutline(page, []);
  await page.route("**/api/auth/subscription/list", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("Denied")) },
    });
  });
  const secret = "dfc_" + "b".repeat(64);
  const requests: RequestRecord[] = [];
  const keys: unknown[] = [];
  await page.route("**/api/keys", (route) => {
    const request = route.request();
    requests.push({
      method: request.method(),
      body: request.postDataJSON(),
    });
    if (request.method() === "GET") return route.fulfill({ json: { keys } });
    const entry = {
      id: "setup-key",
      name: "My phone",
      suffix: "bbbb",
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: 2,
      permission: "capture",
    };
    keys.push(entry);
    return route.fulfill({ json: { key: secret, entry } });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Set up Apple Shortcut" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Apple Shortcut" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "iPhone",
  );
  await expect(
    dialog.getByRole("button", { name: "30 days", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", { name: "Read-only", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Read and write", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Your keys" })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByText(
      "Open the signed Dotflowy.shortcut file in Shortcuts and paste your key during setup. Your installed shortcut contains the key, so treat it as a credential.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText(/sharing a configured shortcut also shares/),
  ).toHaveCount(0);
  const install = dialog.getByRole("link", {
    name: "Add to Apple Shortcuts",
  });
  await expect(install).toHaveAttribute(
    "href",
    "https://app.dotflowy.com/shortcuts/Dotflowy.shortcut",
  );
  await expect(install).toHaveAttribute("rel", "noopener noreferrer");
  await expect(dialog.locator('a[href$=".shortcut"]')).toHaveCount(1);
  expect(requests).toEqual([]);

  await dialog.getByLabel("Name", { exact: true }).fill("My phone");
  await dialog.getByRole("button", { name: "Create key" }).click();
  const field = dialog.getByLabel("New API key");
  await expect(field).toHaveValue(secret);
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Couldn't copy automatically",
  );
  await field.click();
  await expect
    .poll(() =>
      field.evaluate((element: HTMLInputElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    )
    .toEqual([0, secret.length]);
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  expect(requests).toEqual([
    {
      method: "POST",
      body: { name: "My phone", expiry: "30d", permission: "capture" },
    },
  ]);

  await dialog.getByRole("button", { name: "Copy installation link" }).click();
  const linkField = dialog.getByLabel("Installation link", { exact: true });
  await expect(linkField).toHaveValue(
    "https://app.dotflowy.com/shortcuts/Dotflowy.shortcut",
  );
  await linkField.click();
  await expect
    .poll(() =>
      linkField.evaluate((element: HTMLInputElement) =>
        element.value.slice(element.selectionStart!, element.selectionEnd!),
      ),
    )
    .toBe("https://app.dotflowy.com/shortcuts/Dotflowy.shortcut");
  // Exercise link handoff, not native installation. Neither the key nor
  // captured content may be appended to the public file URL.
  await page
    .context()
    .route("https://app.dotflowy.com/shortcuts/Dotflowy.shortcut", (route) =>
      route.fulfill({ body: "Shortcut file handoff fixture" }),
    );
  const popupPromise = page.waitForEvent("popup");
  await install.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(
    "https://app.dotflowy.com/shortcuts/Dotflowy.shortcut",
  );
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue(secret);
  await expect(dialog.getByText("Installed", { exact: true })).toHaveCount(0);
  await popup.close();

  await dialog
    .getByRole("link", { name: "Manage API keys in Settings" })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/settings#capture-keys$/);
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "API keys" });
  await expect(manager.getByText("My phone", { exact: true })).toBeVisible();
  await expect(manager.getByLabel("New API key")).toHaveCount(0);
  await manager.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Set up Apple Shortcut" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("New API key")).toHaveCount(0);
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "iPhone",
  );
  await expect(
    dialog.getByRole("button", { name: "30 days", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("Apple Shortcut creation errors preserve input and pending creation cannot lose the one-time key", async ({
  page,
}) => {
  await seedOutline(page, []);
  await page.route("**/api/auth/subscription/list", (route) =>
    route.fulfill({ json: [] }),
  );
  let attempts = 0;
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/keys", async (route) => {
    attempts += 1;
    if (attempts === 1)
      return route.fulfill({
        status: 403,
        json: { message: "Sign in again to create a key." },
      });
    await pending;
    return route.fulfill({
      json: {
        key: "dfc_test",
        entry: {
          id: "pending",
          name: "iPhone",
          suffix: "test",
          createdAt: 1,
          lastUsedAt: null,
          expiresAt: Date.UTC(2099, 0, 2),
          permission: "capture",
        },
      },
    });
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Set up Apple Shortcut" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Apple Shortcut" });
  await dialog.getByRole("button", { name: "90 days", exact: true }).click();
  await dialog.getByRole("button", { name: "Create key" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Sign in again to create a key.",
  );
  await expect(
    dialog.getByRole("button", { name: "90 days", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Create key" }).click();
  await expect(
    dialog.getByRole("button", { name: "Creating…" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.keyboard.press("Escape");
  await dialog
    .getByRole("link", { name: "Manage API keys in Settings" })
    .click({ force: true });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  finish!();
  await expect(dialog.getByLabel("New API key")).toHaveValue("dfc_test");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Create key" }),
  ).toBeDisabled();
  expect(attempts).toBe(2);
});
