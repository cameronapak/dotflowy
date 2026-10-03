import { expect, test, type Page } from "@playwright/test";

import { seedOutline } from "./fixtures";

interface RequestRecord {
  method: string;
  body: unknown;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("dotflowy:flag:external-capture", "on");
  });
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

test.describe("CaptureKeysDialog", () => {
  test("creates, reveals once, copies, and clears the secret on close", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const secret = "dfc_" + "a".repeat(64);
    const requests: RequestRecord[] = [];
    await page.route("**/api/capture-keys", async (route) => {
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
            expiresAt: null,
          },
        },
      });
    });

    await mountDialog(page);
    await expect(
      page.getByRole("heading", { name: "Capture keys" }),
    ).toBeVisible();
    await expect(page.getByText("No capture keys yet.")).toBeVisible();
    await page.getByLabel("Name").fill("My iPhone");
    await page.getByLabel("Expiration").selectOption("90d");
    await page.getByRole("button", { name: "Create key" }).click();

    await expect(page.getByLabel("New capture key")).toHaveValue(secret);
    const dialog = page.getByRole("dialog");
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const copy = page.getByRole("button", { name: "Copy", exact: true });
    const copyBounds = await copy.boundingBox();
    expect(copyBounds!.x + copyBounds!.width).toBeLessThanOrEqual(390);
    expect(requests.at(-1)).toEqual({
      method: "POST",
      body: { name: "My iPhone", expiry: "90d" },
    });
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(secret);

    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Manage", exact: true }).click();
    await expect(page.getByLabel("New capture key")).toHaveCount(0);
  });

  test("retries list failures and confirms individual and all-key revocation", async ({
    page,
  }) => {
    let gets = 0;
    const deletes: unknown[] = [];
    const keys = [
      {
        id: "phone",
        name: "Phone",
        suffix: "1111",
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
      },
      {
        id: "tablet",
        name: "Tablet",
        suffix: "2222",
        createdAt: 2,
        lastUsedAt: 3,
        expiresAt: 4,
      },
    ];
    await page.route("**/api/capture-keys", async (route) => {
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
      deletes.push(request.postDataJSON());
      return route.fulfill({ json: { revoked: true } });
    });

    await mountDialog(page);
    await expect(page.getByRole("alert")).toHaveText("Try later");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Phone", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Revoke Phone" }).click();
    await page
      .getByRole("button", { name: "Confirm revoke", exact: true })
      .click();
    await expect(page.getByText("Phone", { exact: true })).toHaveCount(0);
    expect(deletes[0]).toEqual({ id: "phone" });

    await page.getByRole("button", { name: "Revoke all" }).click();
    await page.getByRole("button", { name: "Confirm revoke all" }).click();
    await expect(page.getByText("No capture keys yet.")).toBeVisible();
    expect(deletes[1]).toEqual({});
  });
});

test.describe("Apple Shortcut setup", () => {
  for (const entryPoint of ["More", "Settings"] as const) {
    test(`${entryPoint} opens focused setup with manual copy and a separate manager`, async ({
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
      await page.route("**/api/capture-keys", (route) => {
        const request = route.request();
        requests.push({
          method: request.method(),
          body: request.postDataJSON(),
        });
        if (request.method() === "GET")
          return route.fulfill({ json: { keys } });
        const entry = {
          id: "setup-key",
          name: "My phone",
          suffix: "bbbb",
          createdAt: 1,
          lastUsedAt: null,
          expiresAt: 2,
        };
        keys.push(entry);
        return route.fulfill({ json: { key: secret, entry } });
      });

      await page.goto(entryPoint === "More" ? "/" : "/settings");
      if (entryPoint === "More") {
        await page.getByRole("button", { name: /More actions/ }).click();
        await page
          .getByRole("menuitem", { name: "Add Apple Shortcut" })
          .click();
      } else {
        await page
          .getByRole("button", { name: "Set up Apple Shortcut" })
          .click();
      }
      const dialog = page.getByRole("dialog", { name: "Add Apple Shortcut" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
        "iPhone",
      );
      await expect(dialog.getByLabel("Expiration")).toHaveValue("never");
      await expect(
        dialog.getByRole("heading", { name: "Your keys" }),
      ).toHaveCount(0);
      await expect(
        dialog.getByText(/Experimental. Installation and capture/),
      ).toBeVisible();
      const install = dialog.getByRole("link", {
        name: "Add to Apple Shortcuts",
      });
      await expect(install).toHaveAttribute(
        "href",
        "https://www.icloud.com/shortcuts/2f1344efd7ac4206a68e451cb5df7139",
      );
      await expect(install).toHaveAttribute("rel", "noopener noreferrer");
      await expect(dialog.locator('a[href$=".shortcut"]')).toHaveCount(0);
      expect(requests).toEqual([]);

      await dialog.getByLabel("Name", { exact: true }).fill("My phone");
      await dialog.getByLabel("Expiration").selectOption("30d");
      await dialog.getByRole("button", { name: "Create key" }).click();
      const field = dialog.getByLabel("New capture key");
      await expect(field).toHaveValue(secret);
      await dialog.getByRole("button", { name: "Copy", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText(
        "Couldn't copy automatically",
      );
      await field.click();
      expect(
        await field.evaluate((element: HTMLInputElement) => [
          element.selectionStart,
          element.selectionEnd,
        ]),
      ).toEqual([0, secret.length]);
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(requests).toEqual([
        { method: "POST", body: { name: "My phone", expiry: "30d" } },
      ]);

      await dialog
        .getByRole("button", { name: "Copy installation link" })
        .click();
      const linkField = dialog.getByLabel("Installation link", { exact: true });
      await expect(linkField).toHaveValue(
        "https://www.icloud.com/shortcuts/2f1344efd7ac4206a68e451cb5df7139",
      );
      await linkField.click();
      expect(
        await linkField.evaluate((element: HTMLInputElement) =>
          element.value.slice(element.selectionStart!, element.selectionEnd!),
        ),
      ).toBe(
        "https://www.icloud.com/shortcuts/2f1344efd7ac4206a68e451cb5df7139",
      );
      // Exercise handoff without relying on Apple's availability. Neither
      // the key nor captured content may be appended to the public URL.
      await page
        .context()
        .route("https://www.icloud.com/shortcuts/**", (route) =>
          route.fulfill({ body: "Shortcut preview" }),
        );
      const popupPromise = page.waitForEvent("popup");
      await install.click();
      const popup = await popupPromise;
      await expect(popup).toHaveURL(
        "https://www.icloud.com/shortcuts/2f1344efd7ac4206a68e451cb5df7139",
      );
      await expect(dialog).toBeVisible();
      await expect(field).toHaveValue(secret);
      await expect(dialog.getByText("Installed", { exact: true })).toHaveCount(
        0,
      );
      await popup.close();

      await dialog
        .getByRole("link", { name: "Manage capture keys in Settings" })
        .click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(/\/settings#capture-keys$/);
      await page.getByRole("button", { name: "Manage", exact: true }).click();
      const manager = page.getByRole("dialog", { name: "Capture keys" });
      await expect(
        manager.getByText("My phone", { exact: true }),
      ).toBeVisible();
      await expect(manager.getByLabel("New capture key")).toHaveCount(0);
      await manager.getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "Set up Apple Shortcut" }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("New capture key")).toHaveCount(0);
      await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
        "iPhone",
      );
      await expect(dialog.getByLabel("Expiration")).toHaveValue("never");
      await expect(dialog.getByRole("alert")).toHaveCount(0);
    });
  }

  test("creation errors preserve input and pending creation cannot lose the one-time key", async ({
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
    await page.route("**/api/capture-keys", async (route) => {
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
            expiresAt: null,
          },
        },
      });
    });
    await page.goto("/settings");
    await page.getByRole("button", { name: "Set up Apple Shortcut" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Apple Shortcut" });
    await dialog.getByLabel("Expiration").selectOption("1y");
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Sign in again to create a key.",
    );
    await expect(dialog.getByLabel("Expiration")).toHaveValue("1y");
    await dialog.getByRole("button", { name: "Create key" }).click();
    await expect(
      dialog.getByRole("button", { name: "Creating…" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.keyboard.press("Escape");
    await dialog
      .getByRole("link", { name: "Manage capture keys in Settings" })
      .click({ force: true });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/settings$/);
    finish!();
    await expect(dialog.getByLabel("New capture key")).toHaveValue("dfc_test");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Create key" }),
    ).toBeDisabled();
    expect(attempts).toBe(2);
  });
});
