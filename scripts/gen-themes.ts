// Generates src/themes.css (ADR 0082): the color themes' shadcn tokens, from
// the tweakcn presets in scripts/theme-presets/ plus Dotflowy's own palettes.
// Run: bun scripts/gen-themes.ts
const dir = import.meta.dir;
const KEYS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
];

type Vars = Record<string, string>;
const EXTRA = ["primary-raw", "primary-l-min", "primary-l-max", "link-source"];

// Sources. tweakcn presets: github.com/jnsahaj/tweakcn @ a3b47b37,
// utils/theme-presets.ts, Apache-2.0 (Catppuccin values are MIT, Catppuccin).
// Hex values copied as published; Dotflowy derives its own surfaces on top
// (see styles.css), which counts as a modification under Apache-2.0 sec. 4.
const TWEAKCN = {
  "claude-ish": "claude",
  catppuccin: "catppuccin",
  "twitter-ish": "twitter",
  "modern-minimal": "modern-minimal",
} as const;

// Original Dotflowy palettes. Authored here, not derived from any third-party
// theme: Leaf (cool white, slate ink, a fresh lime accent).
const ORIGINAL = {
  leaf: {
    light: {
      background: "oklch(0.985 0.004 230)",
      foreground: "oklch(0.24 0.03 255)",
      card: "oklch(0.995 0.002 230)",
      popover: "oklch(0.995 0.002 230)",
      primary: "oklch(0.88 0.2 128)",
      "primary-foreground": "oklch(0.24 0.06 135)",
      secondary: "oklch(0.95 0.008 240)",
      muted: "oklch(0.95 0.008 240)",
      "muted-foreground": "oklch(0.5 0.03 255)",
      accent: "oklch(0.96 0.03 135)",
      destructive: "oklch(0.58 0.21 25)",
      border: "oklch(0.91 0.01 245)",
      input: "oklch(0.88 0.012 245)",
      ring: "oklch(0.75 0.18 130)",
    },
    dark: {
      background: "oklch(0.17 0.025 260)",
      foreground: "oklch(0.95 0.008 240)",
      card: "oklch(0.21 0.028 260)",
      popover: "oklch(0.22 0.028 260)",
      primary: "oklch(0.86 0.2 128)",
      "primary-foreground": "oklch(0.22 0.05 135)",
      secondary: "oklch(0.26 0.03 260)",
      muted: "oklch(0.26 0.03 260)",
      "muted-foreground": "oklch(0.72 0.025 250)",
      accent: "oklch(0.3 0.05 140)",
      destructive: "oklch(0.68 0.19 25)",
      border: "oklch(1 0 0 / 10%)",
      input: "oklch(1 0 0 / 15%)",
      ring: "oklch(0.8 0.18 130)",
    },
  },
} satisfies Record<string, { light: Vars; dark: Vars }>;

// Fill the shadcn keys a hand-authored theme leaves implicit.
function complete(v: Vars) {
  const out = { ...v };
  out["card-foreground"] ??= v.foreground;
  out["popover-foreground"] ??= v.foreground;
  out["secondary-foreground"] ??= v.foreground;
  out["accent-foreground"] ??= v.foreground;
  out.sidebar ??= v.background;
  out["sidebar-foreground"] ??= v.foreground;
  out["sidebar-primary"] ??= v.primary;
  out["sidebar-primary-foreground"] ??= v["primary-foreground"];
  out["sidebar-accent"] ??= v.accent;
  out["sidebar-accent-foreground"] ??= v.foreground;
  out["sidebar-border"] ??= v.border;
  out["sidebar-ring"] ??= v.ring;
  return out;
}

// Lightness and chroma of an oklch() or #hex color, to pick per-theme bounds.
function lc(color: string): [number, number] {
  const m = color.match(/oklch\(\s*([\d.]+)(%?)\s+([\d.]+)/);
  if (m) return [Number(m[1]) / (m[2] ? 100 : 1), Number(m[3])];
  const hex = color.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const sv = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * sv;
  const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * sv;
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * sv;
  return [L, Math.hypot(A, B)];
}

// An oklch() or #hex color as sRGB #hex, for the status bar and swatches.
function hex(color: string): string {
  const m = color.match(/oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/);
  if (!m) return color.toLowerCase();
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  return `#${rgb
    .map((v) => {
      const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      const n = Math.round(Math.min(1, Math.max(0, c)) * 255);
      return n.toString(16).padStart(2, "0");
    })
    .join("")}`;
}

// Dotflowy keeps the theme's chosen text-on-primary (white or dark) and moves
// the primary's lightness just enough for it to read. A chromatic primary also
// colors links; an achromatic one leaves links on the blue hue.
function derive(v: Vars) {
  const out = { ...v, "primary-raw": v.primary };
  const lightText = lc(v["primary-foreground"])[0] > 0.6;
  out["primary-l-min"] = lightText ? "0" : "0.74";
  out["primary-l-max"] = lightText ? "0.54" : "1";
  if (lc(v.primary)[1] > 0.04) out["link-source"] = "var(--primary-raw)";
  return out;
}

const block = (sel: string, v: Vars) =>
  `${sel} {\n${[...KEYS, ...EXTRA]
    .filter((k) => v[k])
    .map((k) => `  --${k}: ${v[k]};`)
    .join("\n")}\n}`;

const presets = await Bun.file(
  `${dir}/theme-presets/tweakcn-presets.json`,
).json();
const themes: Record<string, { light: Vars; dark: Vars }> = {};
for (const [id, source] of Object.entries(TWEAKCN))
  themes[id] = {
    light: derive(complete(presets[source].light)),
    dark: derive(complete(presets[source].dark)),
  };
for (const [id, t] of Object.entries(ORIGINAL))
  themes[id] = {
    light: derive(complete(t.light)),
    dark: derive(complete(t.dark)),
  };

const css = [
  `/* Color themes (ADR 0082). Generated by scripts/gen-themes.ts; do not edit
 * by hand. See THIRD_PARTY_NOTICES.md.
 *
 * claude-ish, catppuccin, twitter-ish, modern-minimal: color values from the
 * tweakcn presets (https://github.com/jnsahaj/tweakcn, utils/theme-presets.ts
 * at a3b47b37), licensed under the Apache License 2.0. Catppuccin palette
 * Copyright (c) 2021 Catppuccin, MIT License. Modified by Dotflowy: colors only
 * (fonts, radius, shadows dropped), and Dotflowy derives popover, accent,
 * secondary, muted-foreground, and primary lightness from them in styles.css.
 * Theme names are descriptive; not affiliated with Anthropic, X, or Catppuccin.
 *
 * leaf: an original Dotflowy palette. */`,
  ...Object.entries(themes).flatMap(([name, t]) => [
    block(`:root.theme-${name}`, t.light),
    block(`:root.theme-${name}.dark`, t.dark),
  ]),
].join("\n\n");

await Bun.write(`${dir}/../src/themes.css`, css + "\n");

const ts = `// Generated by scripts/gen-themes.ts; do not edit by hand.

/** Each color theme's page background (light, dark) and light primary, as
 *  sRGB hex: the no-flash status bar color and the pickers' swatches. */
export const THEME_COLORS = {
${Object.entries(themes)
  .map(
    ([id, t]) =>
      `  "${id}": {\n    background: ["${hex(t.light.background!)}", "${hex(t.dark.background!)}"],\n    primary: "${hex(t.light.primary!)}",\n  },`,
  )
  .join("\n")}
} as const;
`;
await Bun.write(`${dir}/../src/themes.generated.ts`, ts);
console.log(
  "wrote src/themes.css and src/themes.generated.ts",
  Object.keys(themes),
);
