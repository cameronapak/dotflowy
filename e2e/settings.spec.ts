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
    (url) => url.pathname === "/api/membership",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          plan: "free",
          legacyLeaf: false,
          subs: [],
          welcome: null,
        }),
      }),
  );
}

async function openSettings(page: Page) {
  await page.goto("/settings");
  // Route loading uses the test budget; behavior assertions keep their 5s budget.
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
}

test("the App avatar shows a photo without a referrer and falls back when it fails", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "alpha" });
  const trigger = page.getByRole("button", { name: /Account and help/ });
  await expect(trigger).toHaveText("T");
  const session = await page.evaluate(async () =>
    (await fetch("/api/auth/get-session")).json(),
  );
  let imageWorks = true;
  let referrer: string | undefined;
  await page.route("**/test-avatar.svg", (route) => {
    referrer = route.request().headers()["referer"];
    return imageWorks
      ? route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="green"/></svg>',
        })
      : route.fulfill({ status: 404 });
  });
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      json: {
        ...session,
        user: {
          ...session.user,
          image: new URL("/test-avatar.svg", page.url()).href,
        },
      },
    }),
  );
  await page.reload();
  // Reload includes the lazy editor boot, not just the photo interaction.
  await trigger.waitFor();
  const photo = trigger.locator("img");
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBe(24);
  expect(referrer).toBeUndefined();
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  imageWorks = false;
  await page.reload();
  await trigger.waitFor();
  await expect(photo).toHaveAttribute("data-error");
  await expect(photo).toBeHidden();
  await expect(trigger).toHaveText("T");
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
});

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
  await page.route("**/api/membership", (route) =>
    route.fulfill({
      json: {
        plan: "unlimited",
        legacyLeaf: false,
        subs: [
          { plan: "unlimited", status: "active", cancelAtPeriodEnd: false },
        ],
        welcome: null,
      },
    }),
  );
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

  await expect(
    page.getByText("Included with Pro", { exact: true }),
  ).toHaveCount(3);
  for (const name of ["Connections", "Plugins", "Appearance"]) {
    await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "Plan & billing" }),
  ).toBeVisible();
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

test("a checkout return waits for server confirmation and the thank-you stays dismissed after reload", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  let activated = false;
  let seen = false;
  let failAck = true;
  await page.route("**/api/membership", (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ id: "sub_fixture" });
      if (failAck) {
        failAck = false;
        return route.fulfill({ status: 503, json: {} });
      }
      seen = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      json: {
        // An active entitlement can precede delayed payment confirmation.
        plan: "founding",
        legacyLeaf: false,
        subs: [
          { plan: "founding", status: "active", cancelAtPeriodEnd: false },
        ],
        welcome:
          activated && !seen ? { id: "sub_fixture", plan: "founding" } : null,
      },
    });
  });
  await page.goto("/settings?checkout=success");
  await expect(
    page.getByRole("status").filter({ hasText: "Confirming your membership" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Thank you/ })).toHaveCount(0);
  activated = true;
  await page.getByRole("button", { name: "Check again" }).click();
  const thanks = page.getByRole("dialog", { name: "Thank you, Test." });
  await expect(thanks).toBeVisible();
  await expect(
    thanks.getByRole("button", { name: "Back to my outline" }),
  ).toBeFocused();
  await thanks.getByRole("button", { name: "Back to my outline" }).click();
  await expect(thanks.getByRole("alert")).toBeVisible();
  await thanks.getByRole("button", { name: "Choose a theme" }).click();
  await expect(thanks).toBeHidden();
  await expect(page).toHaveURL(/settings#appearance$/);
  await page.reload();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await expect(
    page.getByRole("radio", { name: "Leaf", exact: true }),
  ).toBeEnabled();
  await expect(thanks).toHaveCount(0);
  await page.goto("/settings?checkout=canceled");
  await expect(
    page.getByRole("status").filter({ hasText: "Checkout canceled" }),
  ).toBeVisible();
  await expect(thanks).toHaveCount(0);
});

test("free accounts can manage API keys from Connections", async ({ page }) => {
  await seedOutline(page, TREE);
  await mockFreePlan(page);
  await page.route("**/api/keys", (route) =>
    route.fulfill({ json: { keys: [] } }),
  );
  await openSettings(page);
  await expect(
    page.getByText("Available on every plan.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("No API keys yet.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "30 days", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Capture only", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Data → Export downloads the whole outline as OPML", async ({ page }) => {
  await interceptDownloads(page);
  await seedOutline(page, TREE);
  await mockFreePlan(page);
  // Load the outline first so the tree store is populated, then SPA-navigate
  // to /settings (the store survives the client-side route change).
  await openSeededOutline(page, { anchorId: "alpha" });

  await page.getByRole("button", { name: "View options" }).click();
  await expect(
    page.getByRole("menuitem", { name: /Copy as Markdown/ }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Account and help/ }).click();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /Copy as Markdown/ }),
  ).toHaveCount(0);
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
