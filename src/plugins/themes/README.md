# themes plugin

A color-theme picker: a curated set of [tweakcn](https://tweakcn.com) themes,
plus the built-in `default` (neutral). The app already uses shadcn semantic
tokens everywhere, so a theme is just a set of CSS-variable values; the picker
swaps `html[data-theme]` and the whole UI re-themes with zero React re-render.

## What's themed (and what isn't)

Colors, `--radius`, and the `--shadow-*` scale. **Not** fonts (the app stays on
Geist), `--spacing` (would rescale the outline's density), or letter-spacing
(no body rule consumes it). Those vars are dropped during generation.

## Regenerating `themes.css`

`themes.css` is **generated** from the tweakcn theme registry. To add/refresh a
theme, edit the `themes` list below and re-run (Bun):

```sh
cd /tmp && bun -e '
const fs = require("fs");
const themes = ["twitter","claude","modern-minimal","neo-brutalism","soft-pop","t3-chat","vercel"];
const EXCLUDE = new Set(["font-sans","font-serif","font-mono","spacing","letter-spacing","tracking-normal","tracking-tight","tracking-tighter","tracking-wide","tracking-wider","tracking-widest"]);
function emit(sel, vars, skip = new Set()) {
  const lines = Object.entries(vars).filter(([k]) => !EXCLUDE.has(k) && !skip.has(k)).map(([k,v]) => `  --${k}: ${v};`);
  return `${sel} {\n${lines.join("\n")}\n}`;
}
let css = "/* GENERATED -- do not hand-edit. Source: tweakcn.com theme registry */\n";
for (const t of themes) {
  const j = await (await fetch(`https://tweakcn.com/r/themes/${t}.json`)).json();
  css += "\n" + emit(`html[data-theme="${t}"]`, j.cssVars.light) + "\n";
  css += emit(`html[data-theme="${t}"].dark`, j.cssVars.dark, new Set(["radius"])) + "\n";
}
fs.writeFileSync("themes.gen.css", css);
'
```

Then copy `themes.gen.css` over `themes.css` and update the swatch values in
`presets.ts` (read each theme's `cssVars.light` for `background`, `primary`,
`accent`, `border`). Run `bun run typecheck` after.

## How it wires up

- `presets.ts` — the catalog (id, label, preview swatch). The core only ever
  sees the opaque `id`.
- `themes.css` — `html[data-theme="x"]` / `...x.dark` blocks. Imported from
  `index.tsx` so it lands in the first-paint stylesheet (not the React-mounted
  `PluginStyles` seam, which would flash the default palette on load).
- `theme-picker.tsx` — the header-slot dropdown (Seam F-header).
- Persistence + first-paint live in the core: `theme-provider.tsx`
  (`useThemePreset`, `previewThemePreset`) and the no-flash script in
  `routes/__root.tsx`, keyed on `THEME_PRESET_KEY`.
