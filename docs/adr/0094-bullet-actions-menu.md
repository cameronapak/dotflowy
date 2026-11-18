---
status: accepted
---

# Bullet actions menu

Issue #192 asked for a mouse path to a bullet's actions, such as Move and
Mirror. Before this, only keyboard users reached them, through Shift+↑
selection (0018) or Cmd+K's "Acting on" list (0034). Cam compared three
prototypes (the dot opens a menu, a row ⋯ button, and pointer selection) and
chose the ⋯ button.

## Decisions

1. **One menu, three ways in.** A ⋯ button at the row's end, `Mod+Shift+.`
   while a bullet holds the caret, and a ⋯ button in the mobile actions bar
   (0030) all open the same per-editor `NodeActionsMenu`.
2. **Cmd+K's action list, not a new registry.** The menu renders
   `buildNodeActions`, the "Acting on" list, for the row's instance id, the
   id Cmd+K's ambient target reads from `data-node-id`. Plugin `CommandSpec`s
   appear without new opt-ins (0034's bridge). The only change is order:
   Delete moves to the end behind a separator.
3. **Row end, not the left gutter.** The issue proposed a button left of the
   bullet, where the hover collapse chevron already sits and moves with depth.
   The row's end is a clean column at every depth. The button reveals on
   hover or focus, as the chevron does, and keeps its box while hidden, so
   revealing it never reflows text.
4. **Not a Tab stop.** Tab indents, so the button has `tabIndex={-1}` and
   advertises `Mod+Shift+.` through `aria-keyshortcuts` and its title. A
   keyboard open focuses the first item; Escape restores the caret.
5. **`Mod+Shift+.`, not Shift+F10 or `Mod+/`.** It is free in the core and
   plugin keymaps, pairs with `Mod+.` (zoom), and is reserved for the core.
   Amp's feedback widget captures only `Mod+.` without Shift. The binding uses
   the hotkey library's raw form, so the physical Period key still matches
   where Shift+. types `>` or `:`. `Mod+/` was rejected because Safari uses
   it for the status bar and it needs Shift on many non-US layouts.
6. **Touch uses the editing bar, and the keyboard stays up.** On coarse
   pointers the row's right edge belongs to the chevron (0029), and below
   768px the canvas keeps its width for text and embeds, so the row button is
   hidden there and the bar holds ⋯. The list opens as a keyboard accessory,
   the same nonmodal panel as the `/` results (0066), not a Liquidglass sheet:
   a modal sheet takes focus and dismisses the software keyboard mid-edit.
   Escape or an outside tap closes it; choosing an action keeps the caret.
7. **Desktop actions run after close.** An action runs when the menu finishes
   closing, so the Move and Mirror pickers and each action's own caret
   handoff are not undone by focus restoration.

## Not changed

Selection (0018) keeps its own multi-node menu. Right-click on text stays
with the browser and the plugin `onContextMenu` seam.
