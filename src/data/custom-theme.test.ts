import { expect, test } from "bun:test";

import {
  contrast,
  customThemeCssFromTokens,
  customThemeName,
  customThemeTokens,
  formatCustomTheme,
  parseCustomTheme,
} from "./custom-theme";

test("a custom theme round-trips through its stored value", () => {
  const one = { h: 262, c: 0.17, tint: 0.3 };
  expect(formatCustomTheme(one)).toBe("custom:1:262,0.17,0.3");
  expect(parseCustomTheme(formatCustomTheme(one))).toEqual(one);
  const two = { h: 262, c: 0.17, tint: 0.45, second: { h: 40, c: 0.12 } };
  expect(parseCustomTheme(formatCustomTheme(two))).toEqual(two);
  // Out-of-range input is wrapped or clamped on the way in, never stored raw.
  expect(formatCustomTheme({ h: 365, c: 0.4, tint: 2 })).toBe(
    "custom:1:5,0.25,1",
  );
});

test("a malformed or out-of-range value is not a custom theme", () => {
  for (const bad of [
    "leaf",
    "custom:",
    "custom:2:262,0.17,0.3",
    "custom:1:262,0.17",
    "custom:1:360,0.17,0.3",
    "custom:1:262,0.3,0.3",
    "custom:1:262,0.17,1.5",
    "custom:1:262,0.17,0.3,40",
    "custom:1:262,0.17,0.3;}body{color:red",
  ])
    expect(parseCustomTheme(bad)).toBeNull();
});

/** sRGB hex to the OKLCH-shaped input `contrast` takes, via its own math. */
function hexContrast(a: string, b: string) {
  const lin = (hex: string) =>
    [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
  const lum = (hex: string) => {
    const [r = 0, g = 0, b = 0] = lin(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("every color choice keeps text and buttons readable in both Modes", () => {
  // The worst cases sit at the extremes: neon yellow on paper, deep blue
  // washed into a dark page, and a second color across the wheel.
  const failures: string[] = [];
  for (let h = 0; h < 360; h += 15)
    for (const c of [0.03, 0.14, 0.25])
      for (const tint of [0, 0.5, 1])
        for (const second of [undefined, { h: (h + 150) % 360, c: 0.25 }])
          for (const mode of ["light", "dark"] as const) {
            const t = customThemeTokens({ h, c, tint, second }, mode);
            const pairs: [string, string, string, number][] = [
              ["text", t.foreground!, t.background!, 4.5],
              ["text on cards", t["card-foreground"]!, t.card!, 4.5],
              ["button text", t["primary-foreground"]!, t["primary-raw"]!, 4.5],
            ];
            for (const [what, fg, bg, min] of pairs) {
              const ratio = hexContrast(fg, bg);
              if (ratio < min)
                failures.push(
                  `${formatCustomTheme({ h, c, tint, second })} ${mode} ${what}: ${ratio.toFixed(2)}`,
                );
            }
          }
  expect(failures).toEqual([]);
  // `contrast` agrees with the plain sRGB formula above.
  expect(contrast({ L: 1, C: 0, H: 0 }, { L: 0, C: 0, H: 0 })).toBeCloseTo(
    21,
    1,
  );
});

test("the stylesheet carries only hex colors, so storage cannot inject CSS", () => {
  const css = customThemeCssFromTokens(
    { background: "#ffffff", foreground: "red;}body{x:y", "a}b": "#000000" },
    { background: "#000000" },
  );
  expect(css).toBe(
    ":root.theme-custom.theme-custom{--background:#ffffff;}:root.theme-custom.theme-custom.dark{--background:#000000;}",
  );
});

test("a theme is named for its colors, never a hex value", () => {
  expect(customThemeName({ h: 255, c: 0.17, tint: 0 })).toBe("Cobalt");
  expect(
    customThemeName({ h: 255, c: 0.17, tint: 0, second: { h: 40, c: 0.12 } }),
  ).toBe("Cobalt & Ember");
});
