---
status: accepted
---

# Bottom drawers for narrow-screen menus

Small, anchored menus are difficult to navigate on a phone. These seven surfaces
use the shared shadcn Base UI drawer below 768px:

- `/` commands, including the mobile toolbar's `/` button.
- Header **More actions**.
- `#` tag suggestions.
- `[[` node-link and date suggestions.
- Quick-add's destination picker, including session-row destinations.
- The calendar month picker.
- Breadcrumb overflow.

At 768px and above, each surface keeps its existing menu or popover. Width chooses
the presentation; pointer type still controls the mobile actions bar's presence
([ADR 0030](./0030-mobile-actions-bar.md)). The drawers have a title, a **Close**
button, a swipe handle, and a scrollable body. Their position follows the visible
viewport, including keyboard resizing and panning, with safe-area padding.

## Typing suggestions leave focus in the editor

The `/`, `#`, and `[[` drawers are non-modal. Opening, scrolling, selecting, and
closing them must preserve the editor's caret and software keyboard. The same
input, filtering, selection, and keyboard handlers serve both presentations in
the outline row, zoomed title, and quick-add editor. The toolbar still inserts a
literal `/` rather than opening a separate menu.

Typing drawers normally use at most half of the visible viewport. On short
keyboard-visible bands, their height limit increases to 168px when possible,
leaving at least 48px above the drawer. Compact headers and rows keep commands
reachable without dismissing the keyboard. The viewport frame uses measured
`offsetTop` and `height`; its drawer anchors inside that frame rather than
subtracting these measurements from `100dvh`, which can drift with Safari chrome.

When the drawer would cover the caret, the outline scrolls the edited line above
it without changing focus or selection. Temporary bottom space lets even a short
outline scroll. While typing suggestions are open, the header and subheader can
scroll away instead of occluding the edited line; dismissal restores sticky
positioning and removes the extra space. Quick-add positions and sizes its own
frame above the drawer, scrolling inside it to keep a wrapped draft's caret
visible. Dismissal leaves the typed trigger and query intact; selecting an option
uses the existing source-text replacement and command logic. Escape closes only
the active suggestion menu. Handle gestures start before native mouse focus is
cancelled, so mouse and touch swipes both leave the editor focused.

## Action menus and destination pickers own focus

The header, breadcrumb, calendar, and destination drawers are modal. Header
toggles stay open; one-shot actions, navigation, and opening another dialog close
the drawer. Header and breadcrumb menus share their open state across the width
breakpoint and initially focus the first enabled item for immediate arrow-key
navigation. Arrow keys skip disabled items. Calendar month navigation stays open;
selecting a day closes it. Disabled actions remain visible but subdued.

Quick-add's destination drawer is a child popup of its dialog, superseding the
narrow-screen anchored-popover choice in
[ADR 0049](./0049-quick-add-capture-surface.md). Close, Escape, swipe, and outside
press dismiss only the child drawer without changing the draft or destination.
Choosing a destination returns to the draft. The capture engine and structural
write behavior do not change.

## Verification boundary

Playwright checks narrow-screen touch interactions, caret preservation, nested
dismissal, synthetic keyboard viewport changes, and the 767px/768px boundary.
Real iPhone keyboard animation and Safari focus behavior still require a device
check, as in ADR 0030.
