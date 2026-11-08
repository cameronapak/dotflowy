---
status: accepted
---

# Screen-height editor shell

The outline routes use one `height: 100%` flex column: header and subheaders in
normal flow, then an overflowing node editor. The mobile tab bar is absolute
within the shell. The root cannot grow with the outline. Settings, auth, and
legal pages retain document scrolling.

Cam accepted this structure after trying it in a separate prototype. Safari can
still pan its outer viewport around the software keyboard. That native movement
is accepted: do not add viewport transforms, document scroll resets, dismissal
spacers, or blur/refocus cycles to counter it. Header and subheaders remain
outside the editor's scroll area; they do not switch positioning during editing.

This changes the vertical scroll owner in
[ADR 0019](./0019-virtualized-outline-rendering.md) and
[ADR 0069](./0069-horizontally-scrollable-outline-canvas.md).
The existing flat virtual list uses the editor element's dimensions and offset.
Day navigation, reading holds, drag projection and auto-scroll, completion
animation, spotlight, and caret reveal use that same scroll surface. Horizontal
canvas scrolling and the visible-row model are unchanged.

The router resets `.outline-scroll` on new navigation and restores it on history
navigation. Day stream search-param updates retain `resetScroll: false`.
Keyboard clearance belongs to the content inside the scroller; padding on the
scroller itself can force its minimum height past the shell in landscape.

The keyboard toolbar still follows the visual viewport, as specified in
[ADR 0030](./0030-mobile-actions-bar.md). Existing input-driven caret reveal and
keyboard clearance act inside the editor, not on the document. They must yield
to reading and selection gestures. Dismissing the keyboard must not request
focus or reopen it. Glass styling, spotlight's focus band, and native focus
semantics remain intact.

If the keyboard leaves less space than the chrome, toolbar, and one text line
combined, inner scrolling cannot expose that line between them. Native viewport
panning remains available; the app does not hide chrome or resize the shell to
manufacture that space. Synthetic viewport tests must distinguish this boundary
from caret-reveal failures in a band that can fit a line.

The alternative of leaving the document scrollable requires sticky chrome to
negotiate Safari's independent viewport movement. A measured spacer and
positioning transitions add lifecycle state without satisfying the accepted
simple layout. Resizing or translating the entire shell on every visual-viewport
event is also outside this decision.

Verification must cover ordinary scrolling, focus across virtualized rows,
editing after panning, keyboard dismissal, Day navigation, and desktop behavior.
Synthetic keyboard geometry and Linux WebKit do not prove native iOS behavior.
iOS Simulator exercises the native keyboard but is not physical-device proof.
