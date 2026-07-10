---
status: accepted
---

# Desktop selection formatting toolbar

**What.** A fine-pointer-only floating capsule that appears above a text selection
inside one outline bullet (or the zoomed title) and toggles **bold / italic /
strike / underline / highlight** plus **create-link** — a Medium/Notion-style
format bar. `SelectionFormatToolbar` (`SelectionFormatToolbar.tsx`), mounted once
inside `OutlineEditor`. It is the fine-pointer twin of the mobile actions bar
(ADR 0030), and deliberately a **separate** surface, not the mobile bar reused.

**Why a new bar, not the mobile bar on desktop.** The mobile bar's six buttons
are **node-scoped** (indent/outdent/undo/redo/complete/slash) — they act on the
focused bullet, not on a selected range, and every one already has a desktop
keyboard shortcut. "Show a bar when I have text selected" means _format the
selected text_, which is a different, selection-scoped action set (bold, link,
highlight). So the honest response is a formatting toolbar over the selection,
not the structural bar in a new place.

**Three orthogonal gates (mirrors ADR 0030's discipline).**

- **Presence = `(pointer: fine)`** — the exact inverse of the mobile bar's coarse
  seam, so the two never coexist. On touch, selecting text fires the OS
  copy/paste callout, which the bar would fight; that world stays on the mobile
  bar.
- **Visibility = a non-collapsed selection within ONE `.node-text` span.** A
  native selection can span multiple bullets, but the wrap operates on a single
  focused element's source (`.node-text` is the contentEditable in both the
  bullet and the title paths), so a cross-bullet range can't be wrapped and the
  bar doesn't offer to. During an active mouse drag-select the bar is suppressed
  (it would jump under the cursor) and recomputes on release; a keyboard
  selection (Shift+arrows) has no pointerdown, so it updates live.
- **Position = the selection's bounding rect** — a floating capsule centered
  above the range, viewport-clamped, flipping below when there's no room above.

**Dumb chrome over a facade (mirrors ADR 0030).** `useSelectionFormatActions`
(in `OutlineEditor`) resolves the focused **mirror-aware content node** internally
and routes every button into the SAME emphasis / highlight / link machinery the
keyboard uses — so the bar inherits their field-edit semantics and protection
guards and adds **no new mutation path**. Every button `preventDefault`s on
`pointerdown` to keep the selection alive across the press (the mobile bar's
trick, here preserving a range instead of a caret).

**Toggle + active state = a pure planner.** A visible button that shows no on/off
state and blindly adds markers would read as broken (press bold on bold text →
`****text****`). So the bar toggles: buttons light when the selection is already
wrapped and re-pressing removes the markers. The math is a DOM-free, unit-tested
planner — `detectMarkerWrap` + `planMarkerToggle` (`src/data/inline-wrap.ts`) —
and `components/wrap.ts` is the thin `document.activeElement` shell around it
(`toggleWrapSelection`). Detection handles the two ways a selection can already
be wrapped (the markers _inside_ the selection — a folded atom picked up whole —
or _flanking_ it) and **guards a single-char marker against a doubled one**
(`*` must not match `**`, `~` not `~~`), which is the only real subtlety now that
v1 emphasis is flat (no nesting).

**`reselect`: the toolbar re-selects, the keymap collapses.** After a toolbar
wrap the interior is re-selected, so the button stays lit and a re-press toggles
straight back off. The emphasis **keymap/slash** path passes `reselect: false` —
it collapses the caret just past the interior, **byte-identical to the old
add-only behavior for a fresh selection**, so the keyboard path is unchanged (and
crucially leaves no lingering range, which otherwise destabilized the e2e page
reloads). The keymap toggle still _unwraps_ a selected formatted run — a genuine
improvement over the old blind double-wrap — it just doesn't keep the selection.

**Highlight and link are the two special cases.**

- **Highlight** can't ride the clean marker toggle because its color lives IN the
  source as a leading emoji (ADR 0035). `toggleHighlightSelection` strips the
  whole run via `parseHighlight` (fences _and_ emoji) on toggle-off, and wraps in
  the bare **default-blue** `==` fence on toggle-on; recoloring stays the
  right-click menu.
- **Link** is **create-only** (no lit state): it wraps the selection as
  `[label](url)` and opens the edit popover to fill the url. This is owned by the
  **links plugin** as a new `/link` `CommandSpec` (Seam C) — the toolbar runs that
  same command through the registry, so create-link lives in the slash palette
  too and the core never imports link semantics. Write-back is verbatim-match-or-
  drop like the edit popover (`submitLinkCreate`).

**Rejected alternatives.**

- **Reuse the mobile bar's buttons on desktop.** Node-scoped and already on the
  keyboard; not what "text selected" asks for.
- **Add-only buttons (no toggle/active state).** A visible bar that double-wraps
  on a second press reads as a bug; toggle is what a formatting toolbar is.
- **A generic marker toggle for highlight.** Its in-source color emoji would be
  left as literal junk on a naive fence-strip; the whole-run strip is correct.
- **Re-select on the keymap path too.** The lingering range broke the e2e
  reload between iterations; collapsing matches the original keyboard feel and is
  side-effect-free.
- **Fixed toolbar position.** Disconnected from the text; the floating capsule
  reads as attached to the selection.
- **All-pointer (desktop + touch).** Collides with the OS selection callout on
  iOS/Android; fine-pointer-only keeps the two bars cleanly split.
- **Link with lit/toggle state.** Detecting an existing link in the selection is
  deferred; create-only ships the 90% and matches how links are made elsewhere.

**e2e.** `e2e/selection-format-toolbar.spec.ts` covers fine-pointer mount /
collapsed-caret hide, bold toggle on+off with the lit state, highlight
default-blue, link create via the popover, and coarse-pointer non-mount. The
pure planner is unit-tested in `src/data/inline-wrap.test.ts`.
