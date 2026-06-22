# ADR 0006: Inline Tailwind classes over a separate CSS file

Status: accepted (2026-06-21)

## Decision

Going forward, styles are written as inline Tailwind utility classes on the markup, not in
a separate CSS file.

## Why

Keeping styles next to the markup they apply to removes the indirection of matching a class
name to a rule in another file, and avoids a growing global stylesheet whose selectors
drift out of sync with the components. Tailwind's utilities cover the styling the app needs.

## Exception

View-transition behavior still needs real CSS (the `:root:active-view-transition-type(zoom)`
rules and reduced-motion guards from [ADR 0003](./0003-zoom-via-view-transitions.md)) because
those selectors can't be expressed as inline utilities. That CSS stays; this decision is
about ordinary component styling.
