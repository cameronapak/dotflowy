// Themes plugin: a color-theme picker (a curated set of tweakcn themes). The
// app already uses shadcn semantic tokens everywhere, so a theme is just a set
// of CSS-variable values; switching one is an O(1) `data-theme` attribute swap
// (no React re-render). The core owns the mechanism -- it persists the preset
// id, mirrors it to `data-theme` (including before first paint, in the
// __root.tsx no-flash script), and treats the id as opaque. This plugin owns
// the policy: the catalog (presets.ts), the picker UI, and the CSS.
//
// Why `import "./themes.css"` instead of the `styles` (PluginStyles) seam: that
// seam mounts via React, AFTER first paint, so a persisted preset would flash
// the default palette until React hydrated. Importing the CSS from this module
// folds it into the bundled stylesheet that ships in the shell <head>, so the
// preset is correct on the very first frame. The CSS keys on
// `html[data-theme="x"]` -- higher specificity than styles.css `:root`/`.dark`,
// so it wins regardless of bundle order.
//
// Font / spacing / letter-spacing vars are intentionally dropped from the
// generated CSS: the app stays on Geist at its native density (only colors,
// radius, and shadows are themed).

import "./themes.css";
import { definePlugin } from "../types";
import { ThemePicker } from "./theme-picker";

export default definePlugin({
  id: "themes",

  // Seam F (header): the color-theme picker, in the header's right cluster.
  headerSlots: [
    {
      id: "theme-picker",
      render: () => <ThemePicker />,
    },
  ],
});
