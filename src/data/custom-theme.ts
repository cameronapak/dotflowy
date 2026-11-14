// Custom themes (ADR 0088). A custom theme is the account's color-theme value
// `custom:1:<hue>,<vividness>,<tint>[,<second hue>,<second vividness>]`. The
// value carries what the person picked, not derived colors, so later contrast
// fixes reach saved themes. From it, this module derives the base tokens a
// preset in themes.css sets; the `:root.themed.themed` layer in styles.css
// derives and clamps the rest, exactly as for presets (ADR 0082).
import { Option, Schema } from "effect";

/** OKLCH: lightness 0..1, chroma, hue in degrees. */
interface Lch {
  L: number;
  C: number;
  H: number;
}

export interface CustomThemeSeed {
  /** First color: buttons, checkboxes, Today, hovered handles. */
  h: number;
  c: number;
  /** How much color fills the page: 0 is paper, 1 is wash. */
  tint: number;
  /** Optional second color: the page tint, links, and the accent surface. */
  second?: { h: number; c: number };
}

export const CUSTOM_PREFIX = "custom:1:";
export const MAX_CHROMA = 0.25;
export const MIN_CHROMA = 0.03;

const num = String.raw`\d{1,3}(?:\.\d{1,3})?`;
const CUSTOM_PATTERN = new RegExp(
  `^custom:1:${num},${num},${num}(?:,${num},${num})?$`,
);

/** The persisted value. Effect Schema, so the Worker decodes writes with it. */
/** The numbers in a value that matched CUSTOM_PATTERN. */
function fields(id: string) {
  const [h = NaN, c = NaN, tint = NaN, h2, c2] = id
    .slice(CUSTOM_PREFIX.length)
    .split(",")
    .map(Number);
  return { h, c, tint, h2, c2 };
}

export const CustomThemeId = Schema.String.check(
  Schema.isPattern(CUSTOM_PATTERN),
  Schema.makeFilter((id: string) => {
    const { h, c, tint, h2, c2 } = fields(id);
    const hueOk = (x: number) => x >= 0 && x < 360;
    const chromaOk = (x: number) => x >= 0 && x <= MAX_CHROMA;
    return (
      hueOk(h) &&
      chromaOk(c) &&
      tint >= 0 &&
      tint <= 1 &&
      (h2 === undefined || (hueOk(h2) && c2 !== undefined && chromaOk(c2)))
    );
  }),
);

const decodeId = Schema.decodeUnknownOption(CustomThemeId);

/** A stored theme value that is a valid custom theme. */
export const isCustomThemeId = (id: string): id is `custom:${string}` =>
  Option.isSome(decodeId(id));

export function parseCustomTheme(id: string): CustomThemeSeed | null {
  return Option.match(decodeId(id), {
    onNone: () => null,
    onSome: (value) => {
      const { h, c, tint, h2, c2 } = fields(value);
      return h2 === undefined || c2 === undefined
        ? { h, c, tint }
        : { h, c, tint, second: { h: h2, c: c2 } };
    },
  });
}

const round = (x: number, digits: number) => Number(x.toFixed(digits));

export function formatCustomTheme(seed: CustomThemeSeed): `custom:${string}` {
  const hue = (h: number) => round(((h % 360) + 360) % 360, 1) % 360;
  const chroma = (c: number) => round(Math.min(MAX_CHROMA, Math.max(0, c)), 3);
  const parts = [
    hue(seed.h),
    chroma(seed.c),
    round(Math.min(1, Math.max(0, seed.tint)), 2),
  ];
  if (seed.second) parts.push(hue(seed.second.h), chroma(seed.second.c));
  return `custom:1:${parts.join(",")}`;
}

// ---------- OKLCH math ----------

const RAD = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

function toLinearRgb({ L, C, H }: Lch): [number, number, number] {
  const a = C * Math.cos(H * RAD);
  const b = C * Math.sin(H * RAD);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-4 && v <= 1.0001);

/** Keep lightness and hue; reduce chroma until the color fits sRGB. */
function gamut(color: Lch): Lch {
  const c = { L: clamp(color.L, 0, 1), C: Math.max(0, color.C), H: color.H };
  if (inGamut(toLinearRgb(c))) return c;
  let lo = 0;
  let hi = c.C;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(toLinearRgb({ ...c, C: mid }))) lo = mid;
    else hi = mid;
  }
  return { ...c, C: lo };
}

const encode = (v: number) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

function rgb(color: Lch): number[] {
  return toLinearRgb(gamut(color)).map((v) =>
    Math.round(clamp(encode(clamp(v, 0, 1)), 0, 1) * 255),
  );
}

export function toHex(color: Lch): string {
  return `#${rgb(color)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

function luminance(color: Lch): number {
  const [r = 0, g = 0, b = 0] = rgb(color).map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two colors, as painted in sRGB. */
export function contrast(a: Lch, b: Lch): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** color-mix(in oklab, a p, b). */
function mix(a: Lch, b: Lch, p: number): Lch {
  const [aa, ab] = [a.C * Math.cos(a.H * RAD), a.C * Math.sin(a.H * RAD)];
  const [ba, bb] = [b.C * Math.cos(b.H * RAD), b.C * Math.sin(b.H * RAD)];
  const x = aa * p + ba * (1 - p);
  const y = ab * p + bb * (1 - p);
  return {
    L: a.L * p + b.L * (1 - p),
    C: Math.hypot(x, y),
    H: (Math.atan2(y, x) / RAD + 360) % 360,
  };
}

/** Move lightness as little as possible until `color` reaches `target` on `bg`. */
function ensureContrast(color: Lch, bg: Lch, target: number, darken?: boolean) {
  const c = gamut(color);
  if (contrast(c, bg) >= target) return c;
  const end = (darken ?? luminance(bg) > 0.18) ? 0 : 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (contrast({ ...c, L: c.L + (end - c.L) * mid }, bg) >= target) hi = mid;
    else lo = mid;
  }
  return gamut({ ...c, L: c.L + (end - c.L) * hi });
}

/** Yellows and limes only look like themselves when light. */
function naturalLightness(h: number, dark: boolean) {
  const d = Math.min(Math.abs(h - 105), 360 - Math.abs(h - 105));
  return (dark ? 0.72 : 0.6) + 0.22 * Math.exp(-((d / 38) ** 2));
}

/** The seed's color as it looks in a Mode: a swatch, a field dot, a handle. */
export function seedColor(h: number, c: number, dark: boolean): string {
  return toHex({ L: naturalLightness(h, dark), C: c, H: h });
}

const WHITE: Lch = { L: 1, C: 0, H: 0 };

/** The nine palette hues (`--hue-*` in styles.css), as starting swatches. */
export const PALETTE_HUES = [
  { name: "Red", h: 25, c: 0.2 },
  { name: "Orange", h: 55, c: 0.17 },
  { name: "Yellow", h: 90, c: 0.16 },
  { name: "Green", h: 150, c: 0.17 },
  { name: "Teal", h: 195, c: 0.12 },
  { name: "Blue", h: 255, c: 0.18 },
  { name: "Indigo", h: 280, c: 0.19 },
  { name: "Purple", h: 310, c: 0.2 },
  { name: "Pink", h: 345, c: 0.2 },
] as const;

/**
 * The base tokens for one Mode, as `#rrggbb`. Only colors: the fixed bounds
 * (`--primary-l-min`/`max`) live in styles.css with the `.theme-custom` rule.
 */
export function customThemeTokens(
  seed: CustomThemeSeed,
  mode: "light" | "dark",
) {
  const dark = mode === "dark";
  const h = seed.h;
  const vivid = clamp(seed.c / 0.2, 0, 1);
  const pageHue = seed.second?.h ?? h;
  const t = clamp(seed.tint, 0, 1);
  const pageChroma = 0.002 + t * (0.012 + 0.04 * vivid);
  const bg = dark
    ? gamut({ L: 0.205 + 0.035 * t, C: pageChroma * 0.9, H: pageHue })
    : gamut({ L: 0.985 - 0.055 * t, C: pageChroma, H: pageHue });
  const fg = dark
    ? gamut({ L: 0.92, C: 0.006 + 0.022 * t, H: pageHue })
    : gamut({ L: 0.26, C: 0.01 + 0.03 * t, H: pageHue });
  const first = gamut({ L: naturalLightness(h, dark), C: seed.c, H: h });

  // Text on primary is white or a deep shade of the hue, whichever needs the
  // fill to move less: lime keeps dark text like Leaf, cobalt keeps white.
  const deep = gamut({ L: 0.2, C: Math.min(0.06, seed.c * 0.4), H: h });
  const onWhite = ensureContrast(first, WHITE, 4.5, true);
  const onDeep = ensureContrast(first, deep, 4.5, false);
  const useWhite =
    Math.abs(onWhite.L - first.L) + (dark ? 0.06 : 0) <=
    Math.abs(onDeep.L - first.L) + (dark ? 0 : 0.08);
  const primary = useWhite ? onWhite : onDeep;

  const card = dark ? mix(bg, WHITE, 0.96) : mix(bg, WHITE, 0.5);
  const border = mix(fg, bg, dark ? 0.15 : 0.12);
  // The second color tints the page (above) and paints links and the quiet
  // accent surfaces; without one, styles.css falls back to the primary.
  const second = seed.second
    ? toHex(
        gamut({
          L: naturalLightness(seed.second.h, dark),
          C: seed.second.c,
          H: seed.second.h,
        }),
      )
    : null;
  const tokens = {
    background: toHex(bg),
    foreground: toHex(fg),
    card: toHex(card),
    "card-foreground": toHex(fg),
    muted: toHex(mix(fg, bg, 0.06)),
    border: toHex(border),
    input: toHex(mix(fg, bg, 0.2)),
    ring: toHex(first),
    sidebar: toHex(bg),
    "sidebar-foreground": toHex(fg),
    "sidebar-primary": toHex(primary),
    "sidebar-primary-foreground": toHex(useWhite ? WHITE : deep),
    "sidebar-accent": toHex(mix(fg, bg, 0.08)),
    "sidebar-accent-foreground": toHex(fg),
    "sidebar-border": toHex(border),
    "sidebar-ring": toHex(first),
    "primary-raw": toHex(primary),
    "primary-foreground": toHex(useWhite ? WHITE : deep),
    "destructive-raw": toHex({ L: dark ? 0.68 : 0.58, C: 0.2, H: 25 }),
  };
  if (!second) return tokens;
  return { ...tokens, "link-source": second, "accent-source": second };
}

/**
 * The stylesheet for `.theme-custom`, both Modes, from per-Mode tokens. The
 * doubled class outranks the fixed `.theme-custom` rule in styles.css wherever
 * the injected element lands in <head>. Anything but `#rrggbb` is dropped, so
 * the no-flash script can rebuild it from storage without injecting CSS.
 */
export function customThemeCssFromTokens(
  light: Readonly<Record<string, string>>,
  dark: Readonly<Record<string, string>>,
): string {
  const block = (tokens: Readonly<Record<string, string>>) =>
    Object.entries(tokens)
      .filter(([k, v]) => /^[a-z-]+$/.test(k) && /^#[0-9a-f]{6}$/i.test(v))
      .map(([k, v]) => `--${k}:${v};`)
      .join("");
  return `:root.theme-custom.theme-custom{${block(light)}}:root.theme-custom.theme-custom.dark{${block(dark)}}`;
}

const NAMES: readonly (readonly [number, string])[] = [
  [12, "Rose"],
  [32, "Coral"],
  [48, "Ember"],
  [66, "Apricot"],
  [84, "Honey"],
  [100, "Citron"],
  [120, "Lime"],
  [142, "Leaf"],
  [162, "Fern"],
  [180, "Mint"],
  [200, "Lagoon"],
  [222, "Tide"],
  [242, "Lake"],
  [262, "Cobalt"],
  [282, "Iris"],
  [300, "Violet"],
  [320, "Plum"],
  [338, "Orchid"],
  [360, "Peony"],
];

function colorName(h: number, c: number): string {
  const hue = ((h % 360) + 360) % 360;
  const base = NAMES.find(([edge]) => hue < edge)?.[1] ?? "Peony";
  return (c < 0.06 ? "Dusty " : c > 0.2 ? "Electric " : "") + base;
}

/** A friendly name, such as "Cobalt" or "Cobalt & Ember". Never a hex value. */
export function customThemeName(seed: CustomThemeSeed): string {
  const first = colorName(seed.h, seed.c);
  if (!seed.second) return first;
  const second = colorName(seed.second.h, seed.second.c);
  return second === first ? first : `${first} & ${second}`;
}
