import { expect, test, type Page } from "@playwright/test";

import {
  customThemeCssFromTokens,
  customThemeTokens,
  formatCustomTheme,
  MAX_CHROMA,
  MIN_CHROMA,
  type CustomThemeSeed,
} from "../src/data/custom-theme";
import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  type SeedNode,
} from "./fixtures";

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

// Custom themes (ADR 0088) are derived, so sample the dot field: every hue
// band, both chroma extremes, both tint extremes, with and without a second
// color whose hue sits far from the first.
const CUSTOM_SEEDS = [
  0, 45, 90, 110, 140, 180, 220, 255, 285, 320, 345, 60,
].map((h, i): CustomThemeSeed => {
  const seed = {
    h,
    c: i % 3 === 0 ? MIN_CHROMA : i % 3 === 1 ? 0.12 : MAX_CHROMA,
    tint: i % 2 ? 1 : 0,
  };
  if (i % 4 < 2) return seed;
  return { ...seed, second: { h: (h + 150) % 360, c: MAX_CHROMA } };
});

/** Pick a theme from the Theme menu in Settings (ADR 0082). */
async function pickTheme(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name: /^Theme, / }).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

declare global {
  interface Window {
    /** What the head script painted before <body> existed. */
    firstPaint?: { classes: string; css?: string | null; bar?: string | null };
  }
}

/** Every preset, then each sampled custom theme as `[label, css]`. */
const THEME_CASES: [string, string | null][] = [
  ...THEMES.map((t): [string, null] => [t, null]),
  ...CUSTOM_SEEDS.map((seed): [string, string] => [
    formatCustomTheme(seed),
    customThemeCssFromTokens(
      customThemeTokens(seed, "light"),
      customThemeTokens(seed, "dark"),
    ),
  ]),
];

/** Paint a preset, or a custom theme's stylesheet, in one Mode. */
async function paintTheme(
  page: Page,
  [theme, css]: [string, string | null],
  dark: boolean,
) {
  await page.evaluate(
    ([theme, css, dark]) => {
      const root = document.documentElement;
      root.classList.remove(
        ...Array.from(root.classList).filter((c) => c.startsWith("theme-")),
      );
      let style = document.getElementById("dotflowy-custom-theme");
      if (css) {
        if (!style) {
          style = document.createElement("style");
          style.id = "dotflowy-custom-theme";
          document.head.append(style);
        }
        style.textContent = css;
      } else style?.remove();
      root.classList.toggle("themed", theme !== "default");
      if (css) root.classList.add("theme-custom");
      else if (theme !== "default") root.classList.add(`theme-${theme}`);
      root.classList.toggle("dark", dark);
    },
    [theme, css, dark] as const,
  );
}

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
  await expect(page.getByRole("button", { name: /^Theme, / })).toBeEnabled();
  const cache = await page.evaluate(() =>
    localStorage.getItem("dotflowy:color-theme"),
  );
  await pickTheme(page, /Leaf, preview/);
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
  await pickTheme(page, /Leaf, preview/);
  await page.getByRole("button", { name: "Back to outline" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\btheme-leaf\b/);
  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByPlaceholder("Search nodes and commands...")
    .fill("Catppuccin");
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
async function contrastFailures(
  page: Page,
  surface: "outline" | "inline" | "settings" | "trial" = "outline",
) {
  const hovered = [];
  const hoverTargets = [
    [".bullet-dot", "background-color", 3],
    [".crumb-link", "color", 4.5],
    [".crumb-ellipsis", "color", 4.5],
  ] as const;
  for (const [selector, property, min] of surface === "outline"
    ? hoverTargets
    : []) {
    const target = page.locator(selector).first();
    await target.hover();
    hovered.push(
      await target.evaluate(
        (el, { selector, property, min }) => ({
          label: `hovered ${selector}`,
          fg: getComputedStyle(el).getPropertyValue(property),
          bg: getComputedStyle(el.closest("button")!).backgroundColor,
          min,
        }),
        { selector, property, min },
      ),
    );
  }
  const inputs = { hovered, surface };
  return page.evaluate(({ hovered, surface }) => {
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
    // Composite actual ancestor backgrounds, including highlights and chip
    // tints. Token pairs alone miss text on layered or translucent surfaces.
    const backgrounds = (el: Element, banner?: Element) => {
      const layers = ["white"];
      for (let p: Element | null = el; p; p = p.parentElement)
        layers.splice(
          1,
          0,
          getComputedStyle(p).backgroundColor,
          // Conservatively check the strongest point of the decorative tint,
          // even though most text sits on a weaker part of the gradient.
          ...(p === banner
            ? ["color-mix(in oklab, var(--primary) 10%, transparent)"]
            : []),
        );
      return layers;
    };
    if (surface === "settings" || surface === "trial") {
      if (surface === "trial") {
        const banner = document
          .querySelector("#billing h3")!
          .closest('[data-slot="card"]')!;
        for (const el of banner.querySelectorAll(
          'h3, p, button, [data-slot="badge"], [data-slot="card-description"], [data-slot="card-content"] > span',
        ))
          check(
            el.textContent!.trim(),
            getComputedStyle(el).color,
            backgrounds(el, banner),
            4.5,
          );
        probe.remove();
        return failures;
      }
      const active = Array.from(
        document.querySelectorAll("#billing span"),
      ).find((el) => el.textContent?.trim() === "Active")!;
      check(
        "Active badge",
        getComputedStyle(active).color,
        backgrounds(active),
        4.5,
      );
      for (const control of document.querySelectorAll('[role="switch"]')) {
        const style = getComputedStyle(control);
        const behind = backgrounds(control.parentElement!);
        const track = [...behind, style.backgroundColor];
        const thumb = control.querySelector('[data-slot="switch-thumb"]')!;
        const label = `${control.getAttribute("aria-label")} ${control.getAttribute("aria-checked") === "true" ? "on" : "off"}`;
        // Either the fill or the border can identify the control's boundary.
        const boundary = Math.max(
          ratio(paint(track), paint(behind)),
          ratio(paint([...track, style.borderTopColor]), paint(behind)),
        );
        if (boundary < 3)
          failures.push(`${label} boundary ${boundary.toFixed(2)} < 3`);
        check(
          `${label} thumb`,
          getComputedStyle(thumb).backgroundColor,
          track,
          3,
        );
      }
      probe.remove();
      return failures;
    }
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
    for (const el of document.querySelectorAll(
      ".node-text code, .node-text .tag, .node-text [data-bible-ref] > span, .node-text .md-spoiler-reveal",
    )) {
      check(
        `inline ${el.textContent}`,
        getComputedStyle(el).color,
        backgrounds(el),
        4.5,
      );
    }
    // The matching palette ink keeps highlighted spoiler bars distinct.
    // Concealment also requires opaque paint and fully transparent letters.
    for (const el of document.querySelectorAll(".node-text [data-spoiler]")) {
      const style = getComputedStyle(el);
      check(
        "spoiler bar",
        style.backgroundColor,
        backgrounds(el.parentElement!),
        3,
      );
      for (const [label, color, alpha] of [
        ["spoiler bar", style.backgroundColor, 255],
        ["spoiler text", style.color, 0],
      ] as const) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        if (ctx.getImageData(0, 0, 1, 1).data[3] !== alpha)
          failures.push(`${label} has incorrect opacity`);
      }
    }
    for (const { label, fg, bg, min } of hovered)
      check(label, fg, [page, bg], min);
    probe.remove();
    return failures;
  }, inputs);
}

test("settings badges and on/off switches stay readable in every theme and Mode", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  let trial = false;
  await page.route("**/api/membership", (route) =>
    route.fulfill({
      json: {
        plan: trial ? "free" : "unlimited",
        trialEligible: trial,
        legacyLeaf: false,
        subs: [],
        welcome: null,
      },
    }),
  );
  await page.goto("/settings");
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Bible references", exact: true }),
  ).toBeChecked();
  const embeds = page.getByRole("switch", { name: "Embeds", exact: true });
  await embeds.click();
  await expect(embeds).not.toBeChecked();
  await page.addStyleTag({ content: "* { transition: none !important; }" });
  const failures: string[] = [];
  for (const surface of ["settings", "trial"] as const) {
    if (surface === "trial") {
      trial = true;
      await page.reload();
      await page
        .getByRole("button", { name: "Start 14-day Pro trial" })
        .waitFor();
      await page.route("**/api/membership/trial", (route) =>
        route.fulfill({ status: 503, json: { error: "Please try again." } }),
      );
      await page
        .getByRole("button", { name: "Start 14-day Pro trial" })
        .click();
      await expect(page.getByRole("alert")).toBeVisible();
      await page.addStyleTag({ content: "* { transition: none !important; }" });
    }
    for (const theme of THEME_CASES)
      for (const dark of [false, true]) {
        await paintTheme(page, theme, dark);
        if (surface === "trial") await page.locator("#billing h3").hover();
        for (const f of await contrastFailures(page, surface))
          failures.push(`${theme[0]} ${dark ? "dark" : "light"}: ${f}`);
        if (surface === "trial") {
          await page
            .getByRole("button", { name: "Start 14-day Pro trial" })
            .hover();
          for (const f of await contrastFailures(page, surface))
            failures.push(`${theme[0]} ${dark ? "dark" : "light"} hover: ${f}`);
        }
      }
  }
  expect(failures).toEqual([]);
});

test("every theme and Mode keeps themed surfaces readable", async ({
  page,
}) => {
  const inlineText = [
    "`pray()` #study #colored John 3:16",
    ...["🔴", "🟠", "🟡", "🟢", "🔵", "🟣"].map(
      (color) => `==${color}\`pray()\` #study #colored John 3:16 ||hidden||==`,
    ),
  ].join(" ");
  await seedOutline(
    page,
    [
      ...TREE,
      { id: "b", parentId: "a", prevSiblingId: null, text: "Beta" },
      { id: "c", parentId: "b", prevSiblingId: null, text: "Gamma" },
      { id: "d", parentId: "c", prevSiblingId: null, text: "Delta" },
      { id: "e", parentId: "d", prevSiblingId: null, text: "Epsilon" },
      {
        id: "f",
        parentId: "e",
        prevSiblingId: null,
        text: inlineText,
      },
    ],
    {
      kv: {
        "tag-colors": [
          { key: "colored", value: { tag: "colored", color: "blue" } },
        ],
      },
    },
  );
  await openSeededOutline(page, { path: "/e", anchorId: "f" });
  await expect(page.locator(".node-text [data-bible-ref] svg")).toHaveCount(14);
  // Reveal a spoiler on yellow while the other highlight colors stay folded.
  const editor = page.locator('li[data-node-id="f"] .node-text');
  const spoilerOffset =
    inlineText.indexOf("||hidden||", inlineText.indexOf("==🟡")) + 2;
  await placeCaret(editor, spoilerOffset);
  await expect(editor.locator('mark[data-highlight="yellow"]')).toHaveAttribute(
    "data-highlight-reveal",
    "",
  );
  await placeCaret(editor, spoilerOffset);
  await expect(editor.locator("[data-spoiler-reveal]")).toBeVisible();
  // Measure settled hover colors, not a frame midway through a transition.
  await page.addStyleTag({ content: "* { transition: none !important; }" });
  const failures: string[] = [];
  for (const theme of THEME_CASES)
    for (const dark of [false, true]) {
      await paintTheme(page, theme, dark);
      // A chosen tag hue blends against its actual surface: the page plus
      // six different highlights must produce seven distinct fills.
      const coloredFills = await editor
        .locator('[data-tag="colored"]')
        .evaluateAll((els) =>
          els.map((el) => getComputedStyle(el).backgroundColor),
        );
      expect(new Set(coloredFills).size, `${theme[0]} ${dark}`).toBe(7);
      for (const f of await contrastFailures(page))
        failures.push(`${theme[0]} ${dark ? "dark" : "light"}: ${f}`);
      // Yellow is the brightest highlight; its dark-mode hover is the tight
      // contrast boundary for an ink-tinted neutral chip.
      for (const selector of [
        '[data-tag="study"]',
        '[data-tag="colored"]',
        "[data-bible-ref] > span",
      ]) {
        await page.locator(`mark[data-highlight="yellow"] ${selector}`).hover();
        for (const f of await contrastFailures(page, "inline"))
          failures.push(`${theme[0]} ${dark ? "dark" : "light"} hover: ${f}`);
      }
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
  await pickTheme(page, "Leaf");
  await expect(page.getByRole("button", { name: "Theme, Leaf" })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/\btheme-leaf\b/);

  // Lose this device's mirror: the account row brings the theme back.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await expect(page.getByRole("button", { name: "Theme, Leaf" })).toBeVisible();
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

test("a phone picks a theme from the Theme sheet", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await seedOutline(page, TREE);
  await page.route("**/api/membership", (route) =>
    route.fulfill({
      json: { plan: "unlimited", legacyLeaf: false, subs: [], welcome: null },
    }),
  );
  await page.goto("/settings");
  await pickTheme(page, "Leaf");
  await expect(page.locator("html")).toHaveClass(/\btheme-leaf\b/);
  await expect(page.locator("dialog[open].lg-sheet-dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Theme, Leaf" }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "Leaf", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});

test("a saved custom theme paints before the app mounts and follows the account", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.route("**/api/membership", (route) =>
    route.fulfill({
      json: { plan: "unlimited", legacyLeaf: false, subs: [], welcome: null },
    }),
  );
  await page.goto("/settings");
  await pickTheme(page, /^Custom, /);
  await expect(
    page.getByRole("button", { name: "Theme, Cobalt" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/\btheme-custom\b/);
  const saved = await page.evaluate(() =>
    localStorage.getItem("dotflowy:color-theme"),
  );
  expect(saved).toMatch(/^custom:1:/);

  // The head script paints it from this device's cache before <body> exists.
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.body) return;
      observer.disconnect();
      window.firstPaint = {
        classes: document.documentElement.className,
        css: document.getElementById("dotflowy-custom-theme")?.textContent,
        bar: document
          .querySelector('meta[name="theme-color"]')
          ?.getAttribute("content"),
      };
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  const light = customThemeTokens(
    { h: 255, c: 0.17, tint: 0.3 },
    "light",
  ).background;
  expect(await page.evaluate(() => window.firstPaint)).toEqual({
    classes: expect.stringMatching(/\bthemed\b.*\btheme-custom\b/),
    css: expect.stringContaining(`--background:${light};`),
    bar: light,
  });

  // A device without the cache shows the account's custom theme once it loads.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // Booting the app under vite dev can take most of the 5s assertion budget.
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
  await expect(
    page.getByRole("button", { name: "Theme, Cobalt" }),
  ).toBeVisible();
  await expect(page.locator("#dotflowy-custom-theme")).toHaveCount(1);
  expect(
    await page.evaluate(() => localStorage.getItem("dotflowy:color-theme")),
  ).toBe(saved);
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
    await pickTheme(page, "Leaf");
    await expect(
      page.getByText(
        "Couldn't save your theme. Your previous theme was restored.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Theme, Dotflowy" }),
    ).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/\btheme-leaf\b/);
    expect(
      await page.evaluate(() => localStorage.getItem("dotflowy:color-theme")),
    ).toBe("default");
  });
