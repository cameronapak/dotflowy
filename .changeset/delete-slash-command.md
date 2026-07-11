---
"dotflowy": minor
---

Add a `/delete` slash command. Deleting a node was already reachable from the
bullet keymap, Cmd+K, and the node-selection menu; this puts it in the `/`
palette too, delegating to the same delete funnel (protection guards, the
big-subtree confirm, atomic batch, and neighbor-focus all apply).

The `/` palette and the `#` / `[[` caret pickers also now open on the zoomed
page title, not just list bullets, so slash commands, tag autocomplete, and
node-link autocomplete all work whether a node is a row or the title you've
zoomed into.
