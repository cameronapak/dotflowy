---
status: accepted
---

# Mobile actions bar

**What.** A mobile-only, keyboard-anchored action strip live only while a bullet is being edited. Six buttons,
grouped: `[outdent ⇤][indent ⇥] | [undo ↺][redo ↻] | [complete ☑][/]`. It gives thumb-reachable access to the
structural + history actions that on desktop are keyboard shortcuts (`Tab`/`Shift+Tab`, `Mod+Z`/`Mod+Shift+Z`,
`Mod+Enter`) plus the `/` command palette — none of which a software keyboard exposes. Compiled default ON
behind the `isMobileBar()` localStorage flag (`dotflowy:flag:mobile-bar`), same escape-hatch shape as
`isVirtualized()` (ADR 0019); deleted once dogfooded.

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
  above the software keyboard. When the viewport isn't shrunk (hardware keyboard / iPad) that gap is 0 and the
  bar falls back to `bottom:0` + `env(safe-area-inset-bottom)`.

**Why pure `visualViewport`, not `env(keyboard-inset-*)`.** The `env(keyboard-inset-*)` CSS environment
variables are Chromium-only; iOS Safari (the primary target) needs the JS `visualViewport` path regardless.
One system that covers both beats two half-systems, so the bar tracks the keyboard entirely in JS.

**Why we blend with iOS's keyboard accessory bar rather than remove it.** On iOS Safari there is **no web API**
to hide or reorder the system keyboard accessory bar (the floating pill with the prev/next-field arrows + a
"Done" check). That control belongs to WebKit; a native app suppresses it via `inputAccessoryView`, the web
has no equivalent, and standalone/PWA mode does not change this. So our bar cannot own that space — a second
full-width bar just *fights* the system one and reads as two competing strips. Instead the bar is styled as a
**floating frosted-glass capsule** that adopts the accessory pill's shape *grammar* — inset from the edges,
large radius, translucent + blurred, soft shadow — so the two read as one two-tier system: our app-action tier
above iOS's system tier. We deliberately match the **family, not iOS's exact tokens** (radius/blur/inset drift
per OS version; chasing them would rot). Two de-duplications keep it from reading as redundant chrome:
**there is no dismiss button** (iOS's own "Done" and Android's back gesture already dismiss the keyboard), and
**complete uses a boxed check (`☑`), not a bare `✓`**, so it can't be mistaken for the "Done" check sitting
right below it. On platforms without an accessory bar (Android, desktop-touch) the same floating capsule still
reads well — it assumes no system bar beneath it, unlike a flat full-width edge bar.

**Why the `/` button inserts a literal `/` instead of toggling a menu.** The button runs
`document.execCommand("insertText", false, "/")` at the caret, faithfully simulating the keystroke so the
row's own `useSlashMenu`/`detectSlash` opens the palette — the bar reuses the exact path a typed `/` takes,
with zero new cross-component menu-state plumbing. It is **insert-and-open, not a true toggle** (closing stays
via Escape or picking a command). A real toggle would need the bar to observe another component's menu state,
which is not worth the plumbing for v1.

**Why `onPointerDown` + `preventDefault` on every button.** Tapping a button must not steal focus from the
contentEditable, or the caret and keyboard collapse and the action loses its target. `preventDefault()` on
`pointerdown` keeps the span focused across the tap — **every** button does this, with no exception now that
there is no dismiss button. (Dismissing is delegated to the system: iOS "Done" / Android back.)

**Why the bar is dumb chrome (a facade over the existing commands).** A `useMobileBarActions` hook inside
`OutlineEditor` closes over `refs` / `findFocusedId` / the existing `commands` (`useNodeCommands`) /
`undo` / `redo` and exposes zero-arg methods, each resolving `findFocusedId()` internally. So the bar inherits
`runStructural` atomicity (ADR 0009), protected-node guards (ADR 0015), and undo coalescing for free — it adds
no new mutation path. Buttons are **static and always-enabled, with no per-node subscription**: feedback lives
at the row (strikethrough on complete, the `.node-acted` flash on move, the protected-node `rejectRow` shake +
toast). Invalid actions safely no-op (indent/outdent boundary returns false, empty-history undo does nothing,
a protected complete shakes and toasts). Wiring per-row bar state would re-fight the ADR 0014 render budget for
no user-visible gain.

**Why core, not a plugin seam.** The six actions are a fixed toolbar. "Plugins contribute bar actions" is a
documented future seam, not built here — a v1 with a stable button set ships without inventing a contribution
API first.

**Rejected alternatives.**
- **Remove iOS's keyboard accessory bar.** Not possible from web Safari (no API); blending is the honest
  response. A native shell (Capacitor `Keyboard.setAccessoryBarVisible(false)` / WKWebView) is the only way to
  truly remove it, and is out of scope.
- **Full-width flat edge bar.** Reads as a second bar fighting iOS's; assumes no system pill beneath it. The
  floating capsule reads as a matched sibling and generalizes to Android/desktop-touch.
- **A dismiss button.** Redundant with iOS "Done" / Android back, and its bare check twinned iOS's "Done"
  check — dropping it de-duplicates and simplifies the control set.
- **Width breakpoint instead of pointer type.** Would show the bar to a desktop user in a narrow window and
  hide it on a large tablet — the wrong axis. Pointer type is the finger signal.
- **`env(keyboard-inset-*)` for positioning.** Chromium-only; iOS needs the JS path anyway (see above).
- **True `/` toggle.** Needs cross-component menu-state observation for a marginal gain over insert-and-open.
- **Per-node reactive button state (enable/disable, checked).** Re-fights the ADR 0014 per-node render budget;
  row-level feedback already tells the user what happened.

**Not e2e-testable → manual iPhone checklist in the PR:** keyboard-relative positioning, `visualViewport`
tracking, iOS contentEditable focus-preservation under `preventDefault`, and how the glass capsule reads
stacked above the system accessory pill — Playwright can't drive a real software keyboard or `visualViewport`
resize, nor render the iOS accessory bar. The e2e suite (`e2e/mobile-actions-bar.spec.ts`) covers the rest:
coarse-only mount, focus/blur visibility, and each button's action wiring.
