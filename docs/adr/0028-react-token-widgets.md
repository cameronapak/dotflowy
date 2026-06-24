# ADR 0028: React token widgets (Seam A renders real TSX as an atomic widget)

Status: accepted (2026-06-24), implemented. Extends the plugin architecture
([ADR 0018](./0018-plugin-architecture.md)) by giving **Seam A** (inline tokens) a
second render mode: instead of a serialized `El` string, a token can render a **real
React component** mounted inside the contentEditable as an **atomic widget**. First (and
only) consumer: the route-bible chip ([ADR 0026](./0026-route-bible-plugin.md)), which
**migrates off** the plugin styles seam ([ADR 0027](./0027-plugin-styles-seam.md)) onto
this one. Directly **revisits a rejected alternative of ADR 0027** ("a React component /
`<Badge>` for the chip"): the custom-element bridge here is what makes that reachable.

## Glossary

- **Widget (React token)** — a Seam-A token whose `render` returns a `WidgetEl` (not an
  `El`). The core mounts the token's `component` (real TSX) for it.
- **`WidgetEl`** — the descriptor: `{ kind: "widget", source, props?, attrs? }`. The core
  stamps `widget` (the token id) so it can address the component.
- **`<dotflowy-widget>`** — the one custom element the core serializes a widget to, and the
  bridge that mounts a React root for it on connect (`src/components/plugin-widget.tsx`).
- **Atom** — a `contenteditable="false"` element carrying its source in `data-src`; the
  existing caret machinery (ADR 0017) treats it as one opaque unit. A widget is always an
  atom.

## Decision

A `TokenSpec.render` may return `El | WidgetEl`, and the token declares a
`component: ComponentType<WidgetProps>`. When `render` returns a `WidgetEl`, the core:

1. **Serializes it to one atom string** — `<dotflowy-widget data-widget="<id>"
   data-src="<source>" data-src-len contenteditable="false" …attrs>` — in the same
   `inlineMarkupHtml` pass as every other token (the innerHTML hot path is unchanged, still
   string-based). `data-src` makes `isAtom`/`readSource`/the caret math (ADR 0017) treat it
   as opaque, exactly like a folded link.
2. **Mounts the component when the browser upgrades that element.** `<dotflowy-widget>` is a
   custom element (registered once, client-only): on `connectedCallback` it creates a React
   root and renders `<Component source props… />`; on `disconnectedCallback` it unmounts
   (deferred a microtask). Because the element re-upgrades on every innerHTML parse, the
   React interior survives the per-keystroke rebuild without the core threading React through
   the contentEditable.

Props cross the string boundary as JSON (`data-props`); `source` rides on `data-src` and is
also passed as a prop. A presentational chip (route-bible) needs only `source`.

route-bible's chip is now `BibleChip` (real TSX: lucide `BookOpen` + `source` +
`ExternalLink`, styled with **Tailwind utility classes**). Its `styles.ts` is **deleted** —
no plugin CSS, no SVG-mask pseudo-elements, no `.bible-ref` class. Click-to-open stays Seam
B (delegated on `data-bible-ref`), so the component is purely visual.

## Why

- **The chip was the lone seam without TSX.** Row slots, header slots, menu entries, and
  overlays already render `ReactNode`. Only inline tokens were `El`-not-React, because they
  live in a contentEditable whose innerHTML the core rebuilds imperatively each keystroke
  (ADR 0014). This seam closes that gap **without** giving up the string hot path.
- **A custom element is the bridge that survives innerHTML.** A plain React portal target
  gets destroyed by `el.innerHTML = …`; a custom element is re-parsed and re-upgraded each
  time, so the browser, not React, owns its lifecycle across rebuilds. The core keeps
  emitting a string; the element does the mounting.
- **Atomic is correct here, and chosen on purpose.** Making the widget an atom
  (`contenteditable="false"` + `data-src`) decouples the **rendered DOM** (icons, components)
  from the **source** the caret counts — so `readSource` reads `data-src`, never the
  component's interior, and the icons can be real elements with zero caret-math cost. The
  caret jumps over the chip (the folded-link model) instead of moving through it char by
  char. We **wanted** that behavior for a Scripture reference; it reuses ADR 0017's machinery
  verbatim (`isAtom` already keys on `data-src`, not on "link").
- **Opt-in superset, not a replacement.** `El` stays the fast path for plain string tokens
  (code, links, tags). Only a token that declares a `component` pays the React-root cost.
  ADR 0018's "one regex, one pass" is intact — the widget is just a different leaf of the
  same `serializeEl`.
- **Verified.** `e2e/route-bible.spec.ts` asserts the atom carries the resolver URL, that
  **two lucide SVGs render inside it** (proof the React root mounted, not a string), and that
  a click opens. The full 46-test suite (every token's caret path) stays green.

## Costs / tradeoffs (accepted)

- **A React root per widget, remounted when its line's text changes.** `decorate`'s render
  cache means a line only rebuilds on an actual text edit (not on caret moves), so widgets
  don't churn while navigating — only while editing the *same* line. For a lightweight chip
  this is negligible; a heavier or very numerous widget would want the portal-host
  optimization below.
- **Props must be JSON-serializable** (they pass through `data-props`). Fine for a chip
  (strings, ids); a widget needing live callbacks would route them through Seam B instead.
- **The caret never enters the widget.** By design (atomic). A widget is not for editable
  inline content — that stays `El` / revealed-source tokens.

## Rejected alternatives

- **JSX→`El` adapter (a JSX pragma that compiles to the `El` descriptor).** Cheaper, and it
  gets Tailwind scanning + authoring ergonomics — but it yields *markup*, not *components*:
  no lucide components, no `<Badge>`, no hooks, and the SVG-mask pseudo-elements would
  survive. It solves styling, not "real TSX." Rejected because the explicit ask was real
  components.
- **Portal host + node-preserving `decorate` diff (keep stable hosts, `createPortal` into
  them).** The closest to "normal React" and it would avoid React-root churn, but it requires
  rewriting `decorate` from an innerHTML-string assignment to a keyed DOM diff — touching the
  hottest, most caret-sensitive path in the editor. Deferred as the **optimization** if
  per-line remounts ever bite; the custom-element approach gets the feature first with no hot-
  path rewrite.
- **Keep `El` + the styles seam (ADR 0027).** What we had. The pseudo-element SVG masks and
  the raw-CSS string are exactly the friction this removes; the chip is now components +
  Tailwind, colocated in the plugin folder with no CSS at all.
- **Shadow DOM for the widget interior.** Still a non-starter for the same reason as ADR
  0027: a shadow boundary around an inline node inside contentEditable breaks selection. The
  atom gives us a clean React island **without** a shadow root; styling is plain Tailwind on
  light-DOM elements.

## Status of the styles seam (ADR 0027)

The plugin styles seam (`PluginDef.styles`, `<PluginStyles>`) **stays** — it is a valid
general capability (and the documented home for a plugin's *static* CSS) — but route-bible,
its only consumer, has moved here, so it currently has **no consumer**. `pluginStyles` is the
empty string and `<PluginStyles>` renders null until the next plugin needs raw CSS. Kept, not
ripped out, mirroring how `ui/sidebar.tsx` is kept as a documented promotion path.

## What changed

- **`src/plugins/types.ts`** — `Json`, `WidgetEl`, `WidgetProps`; `TokenSpec.render` widened
  to `El | WidgetEl`; `TokenSpec.component?`.
- **`src/components/plugin-widget.tsx`** (new) — the `<dotflowy-widget>` custom element +
  React-root host, `registerWidget`, `WIDGET_TAG`. Client-gated for the `/` prerender (ADR
  0004).
- **`src/components/inline-code.ts`** — `serializeEl` handles a `WidgetEl` (→
  `serializeWidget`, the atom string).
- **`src/plugins/registry.ts`** — `renderToken` stamps the widget id and returns
  `El | WidgetEl`; registers each token's `component` via `registerWidget`.
- **`src/plugins/route-bible/chip.tsx`** (new) — `BibleChip`, real TSX + Tailwind.
- **`src/plugins/route-bible/index.tsx`** — `render` returns a `WidgetEl`, sets `component`,
  drops `styles`; interaction selector broadened to `[data-bible-ref]`.
- **`src/plugins/route-bible/styles.ts`** — **deleted**.
- **`e2e/route-bible.spec.ts`** — chip selector → `[data-bible-ref]`; the styles-seam
  computed-style assertion → "two lucide SVGs rendered inside the atom".
