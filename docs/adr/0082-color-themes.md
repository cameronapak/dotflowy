---
status: accepted
---

# Color themes and blended accents

Dotflowy offers color themes beside the light/dark Mode: Dotflowy (the
default), Claude-ish, Catppuccin, Twitter-ish, Modern Minimal, and Leaf. A
theme recolors the shadcn tokens only. Fonts, radius, and shadows stay
Dotflowy's.
Members can also make a Custom theme from one or two colors
([ADR 0088](./0088-custom-themes.md)).

## Blended accents

Every colored thing that is not a shadcn token (tag fills and ink, `==`
highlights, mirror rings, links, the selected Bible-ref atom, the spoiler bar)
is **blended from the active theme**, including in the default theme. Each
palette color is one mid-lightness hue (`--hue-*` in `styles.css`):

- A **fill** is `color-mix(in oklab, hue 24-28%, var(--background))`.
- An **ink** is `color-mix(in oklab, hue 55%, var(--foreground))`, with its
  oklch lightness clamped to the readable side of the Mode.

Foreground already contrasts with background in every theme, so the pair
inherits that contrast, and one rule serves light, dark, and strongly colored
themes. The fixed per-mode tag palette in `tag-colors.ts` is gone; the
`--tag-*` names and the `[data-tag]` override stylesheet
([ADR 0007](./0007-custom-tag-colors.md)) are unchanged.

## Semantic tokens

Plugins and components paint with tokens, never literal colors
([docs/plugins.md](../plugins.md)):

- `--ink`: bullet dots, paragraph glyphs, stream dots. `accent-foreground` in
  the default theme, `foreground` in any other, because shadcn pairs
  `accent-foreground` with `accent`, not with the page.
- `--quote-bar`, `--control-border`: the quote bar and an unchecked checkbox's
  edge, clamped to 3:1 on the page (WCAG 1.4.11).
- `--primary-ink`: node-link text, breadcrumb hover text, and hovered node
  handles (dots, paragraph glyphs, numbers, and quote bars). These marks need
  readable ink on the page or a quiet halo, not the `--primary` fill used by
  buttons. Leaf keeps its bright green filled controls and uses a deeper green
  ink in light Mode.
- `--link`, `--spoiler`, `--atom-*`, `--mirror-*`.

Registry themes use `accent` as a brand color and ship popovers darker than the
page or pure white, while Dotflowy uses `accent` as its quiet hover and
selection surface. So `:root.themed` derives `popover`, `accent`, `secondary`,
and `muted-foreground` from the theme's background, foreground, and primary,
and clamps `primary`'s lightness so its own `primary-foreground` reads on it.
`destructive` keeps the theme's red but clamps its lightness like tag ink, and
a near-gray registry destructive takes a plain red so danger stays red.
Liquid Glass surfaces take their sheet and tint from the same tokens.

Settings use the same contrast contracts on their actual card surfaces. The
Active status uses the standard secondary Badge (12px, foreground on a quiet
surface), not primary fill as small text on a tint. Switches keep each theme's
primary fill but use primary-foreground for checked thumbs in both Modes,
foreground for unchecked thumbs, and control-border for a visible boundary.
This preserves Leaf's bright green while keeping the control and its state
visible; a fill chosen for contrasting button text is not necessarily readable
ink or a visible edge on the page.

## Inline tokens on highlights

Inline code, neutral tags, and standalone Bible chips use translucent
`currentColor` fills and theme-derived `--inline-ink`. Bible chips inside a
highlight use its exact fill through inherited `--highlight-bg`, including
on hover; hover strengthens their border instead. Painting the pill itself
avoids page-colored strips where it extends above or below the mark. Bible
chips use the same proportional padding, line height, and middle alignment
as inline tags, in rows and zoomed titles at every reading size. Inline ink preserves the
theme's foreground hue with its lightness clamped for readable
text on the tinted surface, including hover. Code keeps its monospace face
with a quiet borderless tint rather than an opaque muted box. Chip borders
and any hover fills use the same inline ink in both Modes; no separate dark
hover color is needed. Only chip fills and borders animate, not text color,
so switching Mode cannot briefly leave dark ink on a dark page. Chosen tag
colors keep their chosen hue and mix ratio, but blend toward inherited
`--highlight-bg` inside highlights instead of the page background. The same
colored tag therefore adapts to each highlight without changing its stored
color. Its ink keeps the chosen hue, with stronger lightness inside highlights
to retain 4.5:1 contrast on the compounded fill. Standalone spoilers keep their
opaque themed bar until revealed.
Inside highlights, a spoiler blends 90% matching palette foreground through
`--highlight-fg` with 10% highlight fill: a stronger colored bar, still fully
opaque with transparent text. Revealed spoiler text uses the same
readable inline ink.

The theme contrast sweep measures these tokens on the page and all six
highlight colors, compositing their actual ancestor backgrounds in every
preset and sampled custom theme. It also checks neutral and colored chip
hover on yellow, revealed spoiler text at 4.5:1, and standalone and highlighted
spoiler bars at 3:1. Highlighted spoilers are also checked for opaque paint
and invisible text.

## Theme data and licensing

`src/themes.css` and `src/themes.generated.ts` are generated by
`bun scripts/gen-themes.ts`, whose output already matches oxfmt; edit the
generator, not the output. Claude-ish,
Catppuccin, Twitter-ish, and Modern Minimal come from tweakcn's Apache-2.0
presets (Catppuccin's palette is MIT). Leaf is original.
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) carries the licenses and
what Dotflowy changed. "-ish" names are descriptive, with no logos and no
claim of affiliation. 21st.dev themes are not used: its terms forbid
redistribution and its theme pages carry no license.

## Selection and storage

The theme is an account preference: an `appearance:color-theme` row in
`account-prefs` ([ADR 0064](./0064-account-wide-editor-feature-preferences.md)), so it
follows the user across devices. Mode stays per device. Missing rows and
unknown ids (from a newer client) mean the default theme, and the row decodes
as any string so a new id never breaks other preferences.

`localStorage` (`dotflowy:color-theme`) mirrors the account value. The
no-flash script in `__root.tsx` applies `themed theme-<id>` on `<html>` and the
status bar color before first paint; the account value wins once it loads.
Themes are classes, not `data-theme`, because Liquid Glass reads
`[data-theme]` and Picture-in-Picture copies only `className`.

Pick a theme in Settings → Appearance or from ⌘K ("Theme: …"). Settings shows
the theme as one row like Mode: the current theme opens a menu of every choice,
a sheet below 768px ([ADR 0066](./0066-narrow-screen-menu-drawers.md)). A grid
of every choice took three rows on desktop and seven on a 375px phone. Mode is now
labeled "Mode" in both places.

Additional palettes require Unlimited or Founding; Dotflowy and every Mode
stay free. Free users preview palettes in memory in Settings, without changing
the account row or its localStorage mirror. Leaving Settings or ending the
preview restores the saved, entitled palette. The Worker also gates theme
writes, including alternate KV key/claim paths. On downgrade, the app displays
the default without deleting the saved paid preference, so resubscribing
restores it.

Themes shipped free briefly on November 13, 2026. A read-only production check
found only the owner's outline and one free account with Leaf saved. Cam chose
to keep Leaf available to that free account. `worker/membership.ts` holds the
single stable-ID, Leaf-only exception. There is no migration, entitlement
table, email matching, or customer-facing grandfathering notice.

## Status bar

One unscoped `theme-color` meta follows the computed page background, which
reflects both theme and Mode. iOS Safari does not reliably repaint a
media-scoped tag.

## Checks

`e2e/color-themes.spec.ts` measures contrast from the real stylesheet for every
theme and Mode: 4.5:1 for text (including destructive text on the page and
in menus), tag ink on its fill, and highlights; 3:1 for
bullet dots, quote bars, checkbox edges, mirror rings, and the spoiler bar.
It also renders Settings with a paid plan and both switch states, measuring
4.5:1 for the Active badge on its actual tint and 3:1 for switch boundaries and
thumbs against their actual backgrounds. Add a theme to its list when adding
one to the generator. The same spec covers a failed account load or save: the
previous theme comes back.
