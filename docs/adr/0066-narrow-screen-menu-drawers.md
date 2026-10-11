---
status: accepted
---

# Narrow-screen sheets and typing suggestions

Below 768px, More actions, breadcrumb overflow, the calendar month picker, and
Quick-add destinations use React Aria Sheet. Typing suggestions (`/`, `#`, and
`[[`) use a compact results panel above the keyboard instead. At 768px and above,
the existing anchored menus and popovers remain unchanged.

This supersedes the original decision to use Base UI drawers for all seven
surfaces and the subsequent attempt to imitate Adobe's native scrolling inside
Base UI. Matching [Adobe's Sheet](https://react-aria.adobe.com/blog/sheet) directly
is preferable to maintaining a second gesture implementation. A modal sheet is
not suitable for suggestions that must leave focus in an external editor.

## Modal sheets use Adobe's implementation

React Aria owns native scroll snapping, swipe momentum, scroll chaining,
keyboard accommodation, entry/exit, focus containment and restoration, and
reduced motion. Keep Dotflowy's colors and typeface, with 32px top corners, 8px
side insets, an 80-by-6px handle, and a 40% black backdrop without blur. The
surface continues below the screen during overscroll. No custom snap points or
JavaScript mouse-drag implementation are added.

Each sheet has a sticky header with a title and an X button labelled Close.
The handle and header stay visible while the contents scroll. The existing
`scroll-fade` utility fades overflowing content below the header, leaving the
header opaque. Its plain-scroll fallback is unchanged. Action-menu text has a
16px inset; the X's 44px target supplies its own visible right inset. Calendar
and destination content use compact spacing. React Aria's overscroll padding
requires a content-box sheet despite Tailwind's border-box default.

React Aria Components is pinned to 1.22.0 with a Bun patch that processes every
IntersectionObserver entry. Its original `entries[0]` misses the expanded state
when instant, reduced-motion entry batches invisible and visible observations.
Remove the patch when an upstream release handles those batches. CSS rounds
intrinsic sheet heights where `calc-size` is supported so Chromium's pixel-rounded
snap offset does not leave fractional content outside the visibility observer.
While a sheet is present, release the page's stable scrollbar gutter: otherwise
it clips React Aria's viewport-wide stage on narrow desktop windows.

Header toggles stay open. One-shot actions and navigation close the sheet.
Header and breadcrumb menus share open state across the width breakpoint and
focus their first enabled item after entry. Arrow keys skip disabled items.
Calendar month navigation stays open; selecting a day closes it.

Quick-add's destination sheet stays inside the capture dialog's DOM focus
boundary. Its overlay uses fixed positioning, and the capture frame uses no
transform, so this containment does not change its viewport geometry. Close,
Escape, swipe, and outside press dismiss the destination sheet independently.
The draft and capture engine are unchanged. This supersedes the narrow-screen
anchored-popover choice in [ADR 0049](./0049-quick-add-capture-surface.md).

## Typing suggestions remain part of editing

The keyboard-attached results panel has no dialog, backdrop, title, handle, or
close button. It shows up to three 44px rows, scrolling additional results,
with a brief enter/exit transition and no animation on each filtered row.
Mobile commands show labels; desktop retains descriptions. While suggestions
are present, they replace the editing toolbar rather than stack above it.
Pointer type still controls whether that toolbar exists ([ADR 0030](./0030-mobile-actions-bar.md)).

Opening, scrolling, selecting, and Escape dismissal preserve the editor's
caret and keyboard. An outside tap dismisses suggestions and may move focus
naturally. Dismissal leaves the typed trigger and query intact. The same input,
filtering, replacement, and keyboard handlers serve outline rows, zoomed
titles, and Quick-add. The toolbar still inserts a literal `/`.

The panel follows the visual viewport without moving the outline. Only a
covered caret requests a minimal smooth page scroll, using the actual panel
height, not its maximum. Active-option navigation scrolls only the result
list. Editing space and nonsticky chrome last for the editing session, not
the menu's lifetime, so filtering and dismissal do not clamp the page's scroll
position. Quick-add budgets space for suggestions and scrolls its draft
internally when text wraps. Exiting suggestions are inert; reduced motion
removes the panel transition and smooth caret scroll.

## Safe areas and verification

The app opts into `viewport-fit=cover`. Page content, sticky chrome, sheets,
typing suggestions, the editing toolbar, and the capture button account for
safe-area insets. Keyboard-attached controls add bottom spacing only when the
visible viewport reaches the layout viewport's bottom.

Playwright covers focus, selection, nested dismissal, scrolling and swipe
reversal, reduced motion, synthetic keyboard viewports, and the 767px/768px
boundary. A WebKit regression covers touch selection: preventing touch
`pointerdown` suppresses its click, so suggestions prevent only `mousedown`
focus changes. Real iPhone keyboard animation, momentum, rubber banding, safe-area
reporting, and Safari/PWA focus behavior still require a device check.
