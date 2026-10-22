---
"dotflowy": patch
---

Scrollable menus, command palettes, and dialog lists now fade softly at their edges when there's more to scroll, so it's clearer when a list runs past what's visible. The breadcrumb trail and mobile action bar get the same left/right hint. The fade dissolves content into the menu's own surface, and the `/` command menu and the `#`/`[[` caret menus now always stay fully on screen instead of clipping off the right or bottom edge. It's pure CSS with no runtime cost, and falls back cleanly to plain scrolling in browsers that don't support scroll-driven animations.
