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
