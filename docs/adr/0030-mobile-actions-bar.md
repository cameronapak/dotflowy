---
status: accepted
---

# Mobile actions bar

**What.** A mobile-only, keyboard-anchored action strip fixed to the bottom of the editor, live only while a
bullet is being edited. Seven buttons, grouped: `[outdent ⇤][indent ⇥] | [undo ↺][redo ↻] | [complete ✓][/] ···· [dismiss ⌄]`.
It gives thumb-reachable access to the structural + history actions that on desktop are keyboard shortcuts
(`Tab`/`Shift+Tab`, `Mod+Z`/`Mod+Shift+Z`, `Mod+Enter`) and to the `/` command palette and keyboard dismissal —
none of which a software keyboard exposes. Compiled default ON behind the `isMobileBar()` localStorage flag
(`dotflowy:flag:mobile-bar`), same escape-hatch shape as `isVirtualized()` (ADR 0019); deleted once dogfooded.

**Signal assignment (the load-bearing decision).** Three orthogonal browser signals drive three orthogonal
behaviors, and keeping them separate is what makes the bar robust:

- **Presence = pointer type.** `matchMedia("(pointer: coarse)")` gates whether the bar exists at all
  (mirrored by a CSS `@media` defense). Pointer type, not viewport width, is the honest "this is a finger"
  signal — the same seam ADR 0029 already uses for the right-edge chevron. A mouse user in a narrow window
  never sees it; a phone always does.
- **Visibility = focus.** The bar shows only while an outline contentEditable span is focused (keyboard-up
  state) and hides on blur. This is not cosmetic: it guarantees every button has a valid target by
  construction — `findFocusedId()` is non-null whenever the bar is visible, so each zero-arg action can
  resolve the node it operates on with no ambiguity and no "nothing selected" state to design around.
- **Position = visual viewport.** A `useKeyboardViewport` hook reads `window.visualViewport` (rAF-throttled)
  and translates the bar up by `innerHeight - (visualViewport.height + visualViewport.offsetTop)` so it rides
  directly above the software keyboard. When the viewport isn't shrunk (hardware keyboard / iPad) that gap is
  0 and the bar falls back to `bottom:0` + `env(safe-area-inset-bottom)`.

**Why pure `visualViewport`, not `env(keyboard-inset-*)`.** The `env(keyboard-inset-*)` CSS environment
variables are Chromium-only; iOS Safari (the primary target) needs the JS `visualViewport` path regardless.
One system that covers both beats two half-systems, so the bar tracks the keyboard entirely in JS.

**Why the `/` button inserts a literal `/` instead of toggling a menu.** The button runs
`document.execCommand("insertText", false, "/")` at the caret, faithfully simulating the keystroke so the
row's own `useSlashMenu`/`detectSlash` opens the palette — the bar reuses the exact path a typed `/` takes,
with zero new cross-component menu-state plumbing. It is **insert-and-open, not a true toggle** (closing stays
via Escape or picking a command). A real toggle would need the bar to observe another component's menu state,
which is not worth the plumbing for v1.

**Why `onPointerDown` + `preventDefault` on every button.** Tapping a button must not steal focus from the
contentEditable, or the caret and keyboard collapse and the action loses its target. `preventDefault()` on
`pointerdown` keeps the span focused across the tap. **Dismiss is the deliberate exception**: it also
`preventDefault`s (so the tap is deterministic) but then explicitly calls `el.blur()` — dismissing the
keyboard is its whole job.

**Why the bar is dumb chrome (a facade over the existing commands).** A `useMobileBarActions` hook inside
`OutlineEditor` closes over `refs` / `findFocusedId` / the existing `commands` (`useNodeCommands`) /
`undo` / `redo` and exposes zero-arg methods, each resolving `findFocusedId()` internally. So the bar inherits
`runStructural` atomicity (ADR 0009), protected-node guards (ADR 0015), and undo coalescing for free — it adds
no new mutation path. Buttons are **static and always-enabled, with no per-node subscription**: feedback lives
at the row (strikethrough on complete, the `.node-acted` flash on move, the protected-node `rejectRow` shake +
toast). Invalid actions safely no-op (indent/outdent boundary returns false, empty-history undo does nothing,
a protected complete shakes and toasts). Wiring per-row bar state would re-fight the ADR 0014 render budget for
no user-visible gain.

**Why core, not a plugin seam.** The seven actions are a fixed toolbar. "Plugins contribute bar actions" is a
documented future seam, not built here — a v1 with a stable button set ships without inventing a contribution
API first.

**Rejected alternatives.**
- **Width breakpoint instead of pointer type.** Would show the bar to a desktop user in a narrow window and
  hide it on a large tablet — the wrong axis. Pointer type is the finger signal.
- **`env(keyboard-inset-*)` for positioning.** Chromium-only; iOS needs the JS path anyway (see above).
- **True `/` toggle.** Needs cross-component menu-state observation for a marginal gain over insert-and-open.
- **Per-node reactive button state (enable/disable, checked).** Re-fights the ADR 0014 per-node render budget;
  row-level feedback already tells the user what happened.

**Not e2e-testable → manual iPhone checklist in the PR:** keyboard-relative positioning, `visualViewport`
tracking, and iOS contentEditable focus-preservation under `preventDefault` — Playwright can't drive a real
software keyboard or `visualViewport` resize. The e2e suite (`e2e/mobile-actions-bar.spec.ts`) covers the rest:
coarse-only mount, focus/blur visibility, and each button's action wiring.
