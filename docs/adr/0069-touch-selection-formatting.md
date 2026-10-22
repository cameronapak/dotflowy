---
status: accepted
---

# Touch selection formatting

On a coarse pointer, a text selection inside one bullet switches the mobile
actions bar ([ADR 0030](./0030-mobile-actions-bar.md)) from its node actions to
the formatting set the desktop toolbar offers
([ADR 0036](./0036-desktop-selection-formatting-toolbar.md)). Collapsing the
selection switches it back. The floating desktop toolbar stays fine-pointer
only: over a touch selection it would collide with the OS copy/paste callout,
while the bar sits at the keyboard, away from the selection and its handles.

## One bar, two modes

The bar shows node actions or format buttons, never both. Every node action
acts on the whole bullet, so none of them helps while text is selected. Undo
is not kept as a pinned escape hatch: each format button toggles, and a lit
button pressed again is that format's undo. The lit state therefore has to read
on the frosted pill, so it inverts the button rather than tinting it.

Visibility still follows focus. Format mode adds one more signal, the
selection, read through the same `readFormatTarget` the desktop toolbar uses:
a single-span, non-collapsed range that is not exactly one folded atom.
Cross-bullet ranges and selected chips leave the bar in edit mode.

Both surfaces render from `FORMAT_BUTTONS`
([`selection-format.tsx`](../../src/components/selection-format.tsx)): bold,
italic, strike, underline, then highlight, spoiler, and link. Seven 44px
targets fit a 375px phone; narrower screens scroll the pill, which already
fires on finger-up only. The buttons call the same `useSelectionFormatActions`
facade, so touch adds no mutation path.

## Selection survival

Every button already prevents `pointerdown` to keep focus. Touch WebKit may
still drop a range on a tap, so the bar saves the selection's source offsets
when a press lands and restores them before the action runs if they changed.

## Native formatting input

The iOS selection menu's Format items, and any platform command that reaches the
editor as `beforeinput`, map onto the marker toggles: `formatBold`,
`formatItalic`, `formatUnderline`, and `formatStrikeThrough`. Every other
`format*` input type is cancelled. Outline text is markdown source, and a
browser-inserted `<b>` or `<font>` would never round-trip.

## Link creation

Below 768px the link form opens as a sheet, following
[ADR 0066](./0066-narrow-screen-menu-drawers.md); a 320px anchored popover on a
phone lands behind the keyboard. Create focuses the url on every screen size,
because the label is the selection the user just made. Inside the sheet the
field is focused by the sheet once it has focus, with `preventScroll`. A plain
`autoFocus` scrolls the page in WebKit mid-entry and strands the sheet offscreen.

## Out of scope

A selection that partly overlaps a formatted run (`**hello** world`, select
"hello world") wraps again and produces stray markers. That is a toggle-planner
bug on both pointers and is fixed separately in `planMarkerToggle`. A "format
the next typed text" mode is not offered: formatting lives in source markers,
and an armed caret would need a pending empty pair.

## Verification

`e2e/mobile-actions-bar.spec.ts` covers the mode switch, toggle with lit state,
a press that collapses the selection, the link sheet, and native format input.
`e2e/selection-format-webkit.spec.ts` repeats the toggle with real WebKit taps
and guards the sheet's entry position. A real iPhone still has to confirm the
selection survives a tap, how the Format menu items arrive, and whether iOS
opens the keyboard for the sheet's programmatic focus.
