// The theme catalog (the policy half of the themes plugin). The core only ever
// sees the opaque `id`; this list -- its labels and preview swatches -- is the
// plugin's own. Adding a tweakcn theme = regenerate themes.css (see README) and
// add a row here.
//
// `swatch` is four representative LIGHT-mode colors for the picker dots; the
// values are raw oklch strings (valid CSS colors) read straight from each
// theme's registry JSON, so a dot is just `style={{ background: <value> }}`.

export interface ThemePreset {
  /** The `data-theme` value (and storage value). "default" = no attribute. */
  id: string;
  label: string;
  swatch: {
    background: string;
    primary: string;
    accent: string;
    border: string;
  };
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "default",
    label: "Default",
    swatch: {
      background: "oklch(0.98 0 0)",
      primary: "oklch(0.205 0 0)",
      accent: "oklch(0.97 0 0)",
      border: "oklch(0.922 0 0)",
    },
  },
  {
    id: "twitter",
    label: "Twitter",
    swatch: {
      background: "oklch(1.0000 0 0)",
      primary: "oklch(0.6723 0.1606 244.9955)",
      accent: "oklch(0.9392 0.0166 250.8453)",
      border: "oklch(0.9317 0.0118 231.6594)",
    },
  },
  {
    id: "claude",
    label: "Claude",
    swatch: {
      background: "oklch(0.9818 0.0054 95.0986)",
      primary: "oklch(0.6171 0.1375 39.0427)",
      accent: "oklch(0.9245 0.0138 92.9892)",
      border: "oklch(0.8847 0.0069 97.3627)",
    },
  },
  {
    id: "modern-minimal",
    label: "Modern Minimal",
    swatch: {
      background: "oklch(1.0000 0 0)",
      primary: "oklch(0.6231 0.1880 259.8145)",
      accent: "oklch(0.9514 0.0250 236.8242)",
      border: "oklch(0.9276 0.0058 264.5313)",
    },
  },
  {
    id: "neo-brutalism",
    label: "Neo Brutalism",
    swatch: {
      background: "oklch(1.0000 0 0)",
      primary: "oklch(0.6489 0.2370 26.9728)",
      accent: "oklch(0.5635 0.2408 260.8178)",
      border: "oklch(0 0 0)",
    },
  },
  {
    id: "soft-pop",
    label: "Soft Pop",
    swatch: {
      background: "oklch(0.9789 0.0082 121.6272)",
      primary: "oklch(0.5106 0.2301 276.9656)",
      accent: "oklch(0.7686 0.1647 70.0804)",
      border: "oklch(0 0 0)",
    },
  },
  {
    id: "t3-chat",
    label: "T3 Chat",
    swatch: {
      background: "oklch(0.9754 0.0084 325.6414)",
      primary: "oklch(0.5316 0.1409 355.1999)",
      accent: "oklch(0.8696 0.0675 334.8991)",
      border: "oklch(0.8568 0.0829 328.9110)",
    },
  },
  {
    id: "vercel",
    label: "Vercel",
    swatch: {
      background: "oklch(0.9900 0 0)",
      primary: "oklch(0 0 0)",
      accent: "oklch(0.9400 0 0)",
      border: "oklch(0.9200 0 0)",
    },
  },
];
