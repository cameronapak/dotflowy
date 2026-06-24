# ADR 0027: Plugin styles seam (a plugin ships its own CSS)

Status: accepted (2026-06-24), implemented. Adds a small seam to the plugin
architecture ([ADR 0018](./0018-plugin-architecture.md)): a plugin contributes its
own CSS instead of adding rules to core `styles.css`. First mover: the route-bible
plugin ([ADR 0026](./0026-route-bible-plugin.md)) moves its `.bible-ref` chip styling
into its folder.

## Glossary

- **Plugin styles seam** — `PluginDef.styles?: string`, a plugin's own CSS, mounted
  once by the core so it lives in the plugin's folder, not core `styles.css`.
- **`<PluginStyles>`** — the single core host (`src/components/plugin-styles.tsx`) that
  renders the concatenated plugin CSS as one React 19 hoisted `<style>`.

## Decision

`PluginDef.styles?: string` — a raw CSS string the plugin owns. `registry.ts`
concatenates every plugin's `styles` (array order) into `pluginStyles`; a single core
component `<PluginStyles>` (mounted once in `__root.tsx`, beside `TagColorStyles`)
renders it as a **React 19 hoisted, deduped `<style href precedence>`**. The core
gains the seam; it never learns what any rule does.

route-bible is the first consumer: its entire chip styling (pill shape, fill, the
book + external-link icon masks, the press-bounce) lives in
`src/plugins/route-bible/styles.ts`. Core `styles.css` carries **zero** `.bible-ref`
rules. The chip element is just `class="bible-ref"` — no Tailwind utility classes
either, so the plugin is self-contained.

Two constraints the seam imposes, both because the string bypasses the build:

- **Raw CSS only** — it is not run through the Tailwind pipeline, so no `@apply` and
  no utility classes; spell every rule out. (Moving `.bible-ref` here surfaced that its
  `:active { @apply translate-y-px }` press-bounce had silently **never worked**: a
  `transform` doesn't apply to an inline box, and the chip span was inline. The fix —
  `display: inline-block` — rides along in `styles.ts`.)
- **Namespace by the plugin's own prefix** (`.bible-ref`, `[data-bible-ref]`). This is
  the *only* thing keeping one plugin's CSS off another's elements.

## Why

- **Colocation is the achievable goal; isolation is not.** The actual request was
  "plugins as isolated packages — core CSS shouldn't bleed in." This delivers the
  reachable half: a plugin's tokens, interactions, **and** styling all live in its
  folder; core `styles.css` stays core. What it deliberately does **not** deliver is
  runtime *encapsulation* — see the rejected alternatives.
- **React 19 `<style>` over a CSS file or a build step.** React 19 hoists and dedupes a
  `<style href precedence>` rendered anywhere in the tree. So the plugin ships a plain
  string and the core mounts it with no bundler wiring, no per-plugin `import "./x.css"`
  in core, and no `import.meta.glob`. It mirrors the existing `TagColorStyles` precedent,
  generalized into a seam.
- **A static string seam, not a component, for static CSS.** `TagColorStyles` stays its
  own component because it is **dynamic** — it regenerates as tag colors change. This
  seam is for a plugin's **static** CSS, where a string is the simplest possible surface.
- **Verified, not assumed.** `e2e/route-bible.spec.ts` asserts the chip computes
  `display: inline-block` — a value only the plugin sheet sets — so a future regression
  that breaks plugin-style mounting fails CI, not just the eye.

## Rejected alternatives

- **Shadow DOM / true scoping.** The honest non-starter. The chip is rendered as an HTML
  string via `innerHTML` **inside the editor's contentEditable** (Seam A serializes an
  `El`; ADR 0014/0017). A shadow root around an inline node inside contentEditable breaks
  selection, caret traversal, and the source-offset model. Real encapsulation is not
  available for inline tokens; pretending otherwise would have shipped a broken editor.
- **A React component / `<Badge>` for the chip.** Same root cause: the chip isn't React
  (it's `innerHTML` the editor hand-syncs on the per-keystroke hot path). The icon
  affordances are `::before`/`::after` pseudo-elements precisely so they stay out of
  `textContent` and keep the caret 1:1 — and pseudo-elements *require* a stylesheet, which
  is what this seam provides. Inline `style=""` can't express them.
- **CSS Modules / build-time scoping per plugin.** Would hash class names, but the chip's
  class is emitted as a literal string inside a serialized `El`, not referenced through a
  module import — so a hashed name can't reach it without threading the generated name
  through the token render. Not worth the machinery for a single-app, compiled-in plugin
  set; prefix convention is enough.
- **Leave it in core `styles.css`.** What we had. Works, but every plugin's rules pile
  into one core file — the exact coupling this seam removes.

## What changed

- **`src/plugins/types.ts`** — `PluginDef.styles?: string`.
- **`src/plugins/registry.ts`** — `pluginStyles` (concatenated, array order).
- **`src/components/plugin-styles.tsx`** — `<PluginStyles>`, the React 19 hoisted host.
- **`src/routes/__root.tsx`** — mounts `<PluginStyles />` beside `<TagColorStyles />`.
- **`src/plugins/route-bible/styles.ts`** — the chip's CSS (moved out of `styles.css`);
  `index.tsx` sets `styles` and reduces the chip class to `"bible-ref"`.
- **`src/styles.css`** — the `.bible-ref` block and its `--bible-ref-icon` var removed
  (the `--external-link-icon` var stays; the links plugin still uses it).
- **`e2e/route-bible.spec.ts`** — a computed-style assertion proving the seam delivers CSS.
