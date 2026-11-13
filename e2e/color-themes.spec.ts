import { expect, test, type Page } from "@playwright/test";

import { openSeededOutline, seedOutline, type SeedNode } from "./fixtures";

// Color themes (ADR 0082). Every themed surface keeps WCAG contrast in every
// theme and Mode, measured from the real stylesheet; and the choice is the
// account's, so it survives losing this device's storage.

const TREE: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "Alpha" },
];

const THEMES = [
  "default",
  "claude-ish",
  "catppuccin",
  "twitter-ish",
  "modern-minimal",
  "leaf",
];

test("Free previews never save, and leaving Settings restores the saved theme", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  const writes: unknown[] = [];
  await page.route("**/api/kv?**", (route) => {
    if (
      route.request().method() === "POST" &&
      new URL(route.request().url()).searchParams.get("collection") ===
        "account-prefs"
    )
      writes.push(route.request().postDataJSON());
    return route.fallback();
  });
  await page.goto("/settings");
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  const leaf = page.getByRole("radio", { name: /Leaf, preview/ });
  await expect(leaf).toBeEnabled();
  const cache = await page.evaluate(() =>
    localStorage.getItem("dotflowy:color-theme"),
  );
  await leaf.click();
  await expect(page.locator("html")).toHaveClass(/\btheme-leaf\b/);
  await expect(
    page.getByText("Previewing Leaf", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("dotflowy:color-theme")),
  ).toBe(cache);
  expect(writes).toEqual([]);
  await page
    .getByRole("button", { name: "Unlock themes", exact: true })
    .click();
  const upgrade = page.getByRole("dialog", { name: "Make Leaf yours" });
  await expect(upgrade).toBeVisible();
  // Canceling the offer preserves the preview, not an entitlement or preference.
  await page.keyboard.press("Escape");
  await expect(upgrade).toBeHidden();
  await page.getByRole("button", { name: "End preview" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\btheme-leaf\b/);
  await leaf.click();
  await page.getByRole("button", { name: "Back to outline" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\btheme-leaf\b/);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("Catppuccin");
  await page.getByRole("option", { name: /Theme: Catppuccin/ }).click();
  await expect(page).toHaveURL(/settings#appearance$/);
  await expect(
    page.getByText("Previewing Catppuccin", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("dotflowy:color-theme")),
  ).toBe(cache);
  expect(writes).toEqual([]);
});

/** Every check below its minimum for the theme and Mode now on <html>. */
function contrastFailures(page: Page) {
  return page.evaluate(() => {
    type Rgb = [number, number, number];
    // Resolve a CSS color through a probe, then composite the layers on a
    // 1px canvas: the sRGB a reader sees.
    const ctx = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true })!;
    const probe = document.createElement("span");
    document.body.append(probe);
    const paint = (layers: string[]): Rgb => {
      ctx.clearRect(0, 0, 1, 1);
      for (const layer of layers) {
        probe.style.color = layer;
        ctx.fillStyle = getComputedStyle(probe).color;
        ctx.fillRect(0, 0, 1, 1);
      }
      const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    const linear = (v: number) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]: Rgb) => {
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    const ratio = (a: Rgb, b: Rgb) => {
      const [la, lb] = [luminance(a), luminance(b)];
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const page = "var(--background)";
    const failures: string[] = [];
    const check = (label: string, fg: string, bg: string[], min: number) => {
      const value = ratio(paint([...bg, fg]), paint(bg));
      if (value < min) failures.push(`${label} ${value.toFixed(2)} < ${min}`);
    };
    check("body text", "var(--foreground)", [page], 4.5);
    check("muted text", "var(--muted-foreground)", [page], 4.5);
    check("link", "var(--link)", [page], 4.5);
    check("node link", "var(--primary-ink)", [page], 4.5);
    check(
      "text on primary",
      "var(--primary-foreground)",
      ["var(--primary)"],
      4.5,
    );
    check("menu text", "var(--popover-foreground)", ["var(--popover)"], 4.5);
    check("destructive text", "var(--destructive)", [page], 4.5);
    check(
      "destructive menu item",
      "var(--destructive)",
      ["var(--popover)"],
      4.5,
    );
    check(
      "selected menu hint",
      "color-mix(in oklab, var(--accent-foreground) 85%, transparent)",
      ["var(--popover)", "var(--accent)"],
      4.5,
    );
    check(
      "bullet dot",
      "color-mix(in oklab, var(--ink) 70%, transparent)",
      [page],
      3,
    );
    check("quote bar", "var(--quote-bar)", [page], 3);
    check("checkbox border", "var(--control-border)", [page], 3);
    check("mirror ring", "var(--mirror-source)", [page], 3);
    check("spoiler bar", "var(--spoiler)", [page], 3);
    for (const c of [
      "red",
      "orange",
      "yellow",
      "green",
      "teal",
      "blue",
      "indigo",
      "purple",
      "pink",
    ]) {
      check(`#${c} tag`, `var(--tag-${c}-fg)`, [page, `var(--tag-${c})`], 4.5);
      check(
        `${c} highlight`,
        "var(--foreground)",
        [page, `var(--tag-${c})`],
        4.5,
      );
    }
    probe.remove();
    return failures;
  });
}

test("every theme and Mode keeps themed surfaces readable", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "a" });
  const failures: string[] = [];
  for (const theme of THEMES)
    for (const dark of [false, true]) {
      await page.evaluate(
        ([theme, dark]) => {
          const root = document.documentElement;
          root.classList.remove(
            ...Array.from(root.classList).filter((c) => c.startsWith("theme-")),
          );
          root.classList.toggle("themed", theme !== "default");
          if (theme !== "default") root.classList.add(`theme-${theme}`);
          root.classList.toggle("dark", dark);
        },
        [theme, dark] as const,
      );
      for (const f of await contrastFailures(page))
        failures.push(`${theme} ${dark ? "dark" : "light"}: ${f}`);
    }
  expect(failures).toEqual([]);
});

test("the color theme is the account's and survives cleared storage", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.route("**/api/membership", (route) =>
    route.fulfill({
      json: { plan: "unlimited", legacyLeaf: false, subs: [], welcome: null },
    }),
  );
  await page.goto("/settings");
  const leaf = page.getByRole("radio", { name: "Leaf" });
  await leaf.click();
  await expect(leaf).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveClass(/\btheme-leaf\b/);

  // Lose this device's mirror: the account row brings the theme back.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("radio", { name: "Leaf" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator("html")).toHaveClass(
    /\bthemed\b.*\btheme-leaf\b|\btheme-leaf\b.*\bthemed\b/,
  );
  // The status bar follows the theme's page background (light Leaf).
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('meta[name="theme-color"]'), (m) =>
          m.getAttribute("content"),
        ),
      ),
    )
    .toEqual(expect.arrayContaining(["rgb(247, 251, 252)"]));
  await expect(
    page.locator(
      'meta[name="theme-color"]:not([content="rgb(247, 251, 252)"])',
    ),
  ).toHaveCount(0);
});

for (const failure of ["account load", "save"] as const)
  test(`a failed ${failure} keeps the previous theme`, async ({ page }) => {
    await seedOutline(page, TREE);
    await page.route(
      (url) =>
        url.pathname === "/api/kv" &&
        url.searchParams.get("collection") === "account-prefs",
      (route) =>
        route.request().method() === (failure === "save" ? "POST" : "GET")
          ? route.fulfill({ status: 500, json: { error: "unavailable" } })
          : route.fallback(),
    );
    await page.route("**/api/membership", (route) =>
      route.fulfill({
        json: { plan: "unlimited", legacyLeaf: false, subs: [], welcome: null },
      }),
    );
    await page.goto("/settings");
    await page.getByRole("radio", { name: "Leaf" }).click();
    await expect(
      page.getByText(
        "Couldn't save your theme. Your previous theme was restored.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: "Dotflowy" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator("html")).not.toHaveClass(/\btheme-leaf\b/);
    expect(
      await page.evaluate(() => localStorage.getItem("dotflowy:color-theme")),
    ).toBe("default");
  });
