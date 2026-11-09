---
status: accepted
---

# Fade navigation while writing

Cam tested the prototype and approved shipping and deployment. Native phone
keyboard and VoiceOver behavior remain outside the browser-emulation evidence.

Typing in a node fades the header, contextual subheaders, mobile navigation
dock, and Add node button to zero opacity. It works with or without Spotlight,
including zoomed titles. Focus alone does not hide navigation.
Mouse or pen movement, a pointer press, scrolling, Escape, Tab, leaving the
editor, or leaving the window restores it. On touch screens, tap or scroll to
restore navigation, then use its controls. The mobile editing toolbar and
content stay visible. Navigation stays visible while its own inputs have focus.

Keep chrome mounted and its space reserved. Do not collapse it, resize the
shell, move the caret, or change scroll offsets. Fade out and restore over
600ms with `ease-in-out` in both directions. Cam requested matching, calm
transitions rather than a faster return. Disable transitions for reduced motion.
Hidden chrome cannot receive pointer actions;
keyboard and assistive-technology focus reveal it. No preference, synced state,
plugin seam, or Node field is added. Capture input at the editor boundary rather
than rerendering React rows on each keystroke. Composition and paste use the
same boundary as ordinary typing.

This amends the always-visible chrome statement in
[ADR 0033](./0033-spotlight-focus-mode.md), without changing Spotlight's content
dimming or alignment. It preserves the geometry and scroll ownership in
[ADR 0077](./0077-screen-height-editor-shell.md). Fading is not extra keyboard
clearance: the hidden header still occupies its normal space. It also fades
the focus session band with the other subheaders; the session keeps running.

Browser verification covers writing versus focus, unchanged content geometry,
mouse and keyboard recovery, header input, zoomed titles, touch recovery,
Spotlight, and reduced motion. Browser touch emulation does not prove native
iPhone keyboard or VoiceOver behavior; those remain part of hands-on testing.
