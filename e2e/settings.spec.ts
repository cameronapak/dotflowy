import { expect, test, type Page } from "@playwright/test";

import { openSeededOutline, seedOutline, type SeedNode } from "./fixtures";

// The /settings page (#171): the home for plan & billing, account, connections,
// data, and appearance — and the reason the header More menu slimmed down.
//
// Stripe Checkout itself can't be driven here (it redirects off-origin), so
// these specs cover the SPA half: the free-plan state, the sections, the
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

async function openSettings(page: Page) {
  await page.goto("/settings");
  // Route loading uses the test budget; behavior assertions keep their 5s budget.
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
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

test("CLI setup explains install, login, and a safe read against this deployment", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedOutline(page, TREE);
  await mockFreePlan(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Set up command line (CLI)" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Use Dotflowy from your terminal",
  });
  await expect(dialog).toBeVisible();
  const origin = new URL(page.url()).origin;
  await expect(dialog.locator("code")).toHaveText([
    "npm install --global dotflowy",
    `dotflowy login --server ${origin}`,
    `dotflowy outline --server ${origin}`,
  ]);
  await expect(
    dialog.getByRole("link", { name: "CLI documentation" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/cameronapak/dotflowy/blob/main/cli/README.md",
  );
  for (const [name, command] of [
    ["Copy install command", "npm install --global dotflowy"],
    ["Copy login command", `dotflowy login --server ${origin}`],
    ["Copy outline command", `dotflowy outline --server ${origin}`],
  ]) {
    await dialog.getByRole("button", { name }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(command);
  }
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("Clipboard denied");
    };
  });
  await dialog.getByRole("button", { name: "Copy install command" }).click();
  await expect(
    page.locator('[data-sonner-toast][data-type="error"]'),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Set up", exact: true }).click();
  const mcp = page.getByRole("dialog", { name: "Connect to your AI apps" });
  await expect(mcp).toBeVisible();
  await expect(mcp.getByRole("textbox").first()).toHaveValue(`${origin}/mcp`);
  await expect(
    mcp.getByRole("tab", { name: "Claude Claude", exact: true }),
  ).toBeVisible();
  const mcpDocs = mcp.getByRole("link", { name: /MCP documentation/ });
  await expect(mcpDocs).toHaveAttribute("href", "https://dotflowy.com/mcp");
  await expect(mcpDocs).toHaveAttribute("target", "_blank");
  await mcp.getByRole("tab", { name: "ChatGPT", exact: true }).click();
  await expect(mcpDocs).toBeVisible();
});

test("free settings exposes its sections, connections nudge, and disclosed upgrade paths", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await mockFreePlan(page);
  await openSettings(page);

  await expect(page.getByText(/Connecting AI apps requires/i)).toBeVisible();
  for (const name of [
    "Connections",
    "Editor features",
    "Appearance",
    "Experimental",
  ]) {
    await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "Plan & billing" }),
  ).toBeHidden();
  await page.locator("summary", { hasText: "Other settings" }).click();
  for (const name of ["Plan & billing", "Account", "Data"]) {
    await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  }
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

test("free accounts can opt into experimental capture key management", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await mockFreePlan(page);
  await page.route("**/api/capture-keys", (route) =>
    route.fulfill({ json: { keys: [] } }),
  );
  await openSettings(page);
  await expect(
    page.getByText("Available on every plan.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("switch", { name: "Enable experimental quick-add" })
    .click();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Capture keys" }),
  ).toBeVisible();
  await expect(page.getByText("No capture keys yet.")).toBeVisible();
  await expect(page.getByLabel("Expiration")).toHaveValue("never");
  await expect(page.getByText(/Keys let shortcuts and scripts/)).toBeVisible();
  await expect(page.getByRole("button", { name: /shortcut/i })).toHaveCount(0);
});

test("experimental quick-add is default-off, persists opt-in, and reacts to rollback", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await mockFreePlan(page);
  let keyRequests = 0;
  await page.route("**/api/capture-keys", (route) => {
    keyRequests += 1;
    return route.fulfill({ json: { keys: [] } });
  });
  await openSettings(page);
  const toggle = page.getByRole("switch", {
    name: "Enable experimental quick-add",
  });
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Set up Apple Shortcut" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Back to outline" }).click();
  await page.getByRole("button", { name: /more/i }).click();
  await expect(
    page.getByRole("menuitem", { name: "Add Apple Shortcut" }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Settings" }).click();
  expect(keyRequests).toBe(0);

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Set up Apple Shortcut" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Manage", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await expect(toggle).not.toBeChecked();

  await toggle.click();
  await page.getByRole("button", { name: "Back to outline" }).click();
  await page.getByRole("button", { name: /more/i }).click();
  await expect(
    page.getByRole("menuitem", { name: "Add Apple Shortcut" }),
  ).toBeVisible();
  // Model another tab clearing storage: subscribers must read the new value
  // and remove the entry without a reload, including storage's null-key case.
  await page.evaluate(() => {
    localStorage.removeItem("dotflowy:flag:external-capture");
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  await expect(
    page.getByRole("menuitem", { name: "Add Apple Shortcut" }),
  ).toHaveCount(0);
  expect(keyRequests).toBe(0);
});

test("Data → Export downloads the whole outline as OPML", async ({ page }) => {
  await interceptDownloads(page);
  await seedOutline(page, TREE);
  await mockFreePlan(page);
  // Load the outline first so the tree store is populated, then SPA-navigate
  // to /settings (the store survives the client-side route change).
  await openSeededOutline(page, { anchorId: "alpha" });

  await page.getByRole("button", { name: /more/i }).click();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /Copy as Markdown/ }),
  ).toBeVisible();
  for (const gone of [
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
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();

  await page.locator("summary", { hasText: "Other settings" }).click();
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
  await openSettings(page);

  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: "Dark" })
    .click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});
