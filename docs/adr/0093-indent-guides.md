---
status: accepted
---

# Indent guides

Nested rows show a faint vertical line under each expanded parent's bullet, so
you can trace a deep item back to its parent
([issue 558](https://github.com/cameronapak/dotflowy/issues/558)). Guides are on
by default and switch off in Settings → Appearance.

## Rendering

Rows are flat and windowed ([ADR 0019](./0019-virtualized-outline-rendering.md)),
so no element spans a subtree. Each row instead paints its ancestors' lines in
its own indent gutter: one `::before` layer, `depth` columns wide, with a 1px
line per column. Every ancestor of a rendered row is an expanded parent in
view, so the row's depth alone decides its lines. Rows stack flush, so the
segments for one level join into a line that runs exactly as long as that
parent's visible subtree and ends at its next sibling. This adds no DOM and no
tree reads to the row.

- The line sits 16px into its column, the bullet axis on both fine and coarse
  pointers ([ADR 0029](./0029-reading-size-and-touch-targets.md)). `INDENT_PX`
  stays the single source for the column width through `--indent-step`.
- On a fine pointer the chevron sits in the left gutter, centered on the
  parent's bullet axis, so it lands on the parent's guide. While it shows (hover, focus, or collapsed), a mask cuts the guide behind the
  glyph. On a coarse pointer the chevron moves to the right edge, so no cut is
  needed.
- The color derives from `--muted-foreground`, so every color theme and Mode
  follows it ([ADR 0082](./0082-color-themes.md)). `prefers-contrast: more`
  uses the full token.
- Guides are decorative. Indentation still carries the hierarchy, so Forced
  Colors Mode, which drops gradient backgrounds, may hide them.
- Guides do not highlight the focused branch or act as collapse targets. Those
  were explored in closed PRs 59 and 61 and stay out of scope.

## Preference

`appearance:indent-guides` lives in the per-user `account-prefs` namespace,
like `appearance:ai-app-icons`
([ADR 0081](./0081-source-app-attribution.md)). A missing row means on. Saves
are optimistic with rollback, and other tabs and devices refresh on focus
([ADR 0064](./0064-account-wide-editor-feature-preferences.md)).
