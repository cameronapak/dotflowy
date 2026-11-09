---
status: accepted
---

# Narrow-screen sheets and typing suggestions

Below 768px, the View and App menus ([ADR 0072](./0072-split-header-view-and-app-menus.md)), breadcrumb overflow, the calendar month picker, and
Quick-add destinations use Liquidglass Sheet. The narrow-screen link form uses
the same owner. Typing suggestions (`/`, `#`, and
`[[`) use a compact results panel above the keyboard instead. At 768px and above,
the existing anchored menus and popovers remain unchanged.

This supersedes the original Base UI drawers and the later React Aria Sheet
implementation. Cameron chose the exported Liquidglass Sheet after trying the
lab and the app preview. Package defaults take priority over recreating the old
header or gestures. A modal sheet is not suitable for suggestions that must
leave focus in an external editor.

## Modal sheets use the package defaults

`@onlymoein/liquidglass` 0.12.0 owns the native modal dialog, glass material,
corners, handle, spring, detents, and reduced-motion entry/exit. The first detent
is medium (51.6%); dragging the handle expands to large. Short sheets also start
at medium: the exported API has no content-fit height. Do not clamp their CSS
height, because that breaks expansion. There is no app-made title bar, X button,
or second gesture engine. Each dialog has an accessible name. Keyboard users can
scroll to every control without expanding it. Dragging starts only on the
package handle, not inside the scrolling content.

The shared integration lazily loads the package for narrow screens, follows the
app's explicit theme through the package's `data-theme`, focuses a form's
requested first field with `preventScroll`, and preserves menu keyboard
navigation. Pointer opening focuses the named dialog, not the first menu item;
keyboard opening focuses the first enabled item. Tab reaches the controls after
a pointer opening. Native focus restoration remains intact. After pointer dismissal,
only the restored trigger's ring is suppressed; keyboard use restores it.
The native `close` event, not the start of exit, runs link submissions and
menu-to-dialog handoffs. Menu actions that need a new focus target use
`onAfterClose`; clipboard writes and new tabs stay in the original click to
retain browser user activation. Destination selection also waits for that
boundary before returning focus to the Quick-add draft.

The Bun patch fixes package limitations without replacing the spring:
exit travel includes the 8px bottom inset and finishes below half a pixel;
viewport resize/scroll updates the sheet against the unzoomed visual viewport
and preserves its nearest detent. This keeps the sheet above a docked keyboard.
Geometry initializes in a layout effect before paint, and the outer dialog
uses `overflow: clip`: Safari focus panning must not scroll the whole sheet
upward during entry. The inner content remains scrollable. Native dialog
autofocus and the package's focus handoff remain unchanged.
Drag-release snapping also respects reduced motion. Pinch zoom remains native.
Remove each patch hunk when upstream supplies the
same behavior. Both ESM and CommonJS builds are patched. The former React Aria
Sheet patch and its styles are removed.

Content clips to the package's animated corners. App separators use the
package Menu's separator spacing and color. Size-specific lens variables reset
at the sheet boundary: inheriting the toolbar's small SVG filter clips entry
blur to the toolbar's dimensions until the sheet's own lens is ready.
Safe-area spacing keeps controls
clear of screen edges. Reduced transparency, increased contrast, forced colors,
and missing backdrop-filter use the package's opaque surface rather than an
invented palette. These are integration corrections, not unmodified upstream
defaults.

Header toggles stay open. One-shot actions and navigation close the sheet.
Header and breadcrumb menus share open state across the width breakpoint and
focus their first enabled item for keyboard opening. Arrow keys skip disabled items.
Calendar month navigation stays open; selecting a day closes it.

Quick-add's destination sheet stays inside the capture dialog's DOM focus
boundary and uses the native top layer. Escape, handle swipe, and outside press
dismiss the destination sheet independently.
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

Playwright covers focus, selection, nested dismissal, scrolling and handle swipe
reversal, reduced motion, synthetic keyboard viewports, and the 767px/768px
boundary. A WebKit regression covers touch selection: preventing touch
`pointerdown` suppresses its click, so suggestions prevent only `mousedown`
focus changes. Real iPhone keyboard animation, momentum, rubber banding, safe-area
reporting, and Safari/PWA focus behavior still require a device check.
