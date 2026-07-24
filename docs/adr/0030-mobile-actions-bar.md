---
status: accepted
---

# Mobile actions bar

**What.** A mobile-only, keyboard-anchored action strip live only while a bullet is being edited. Six buttons,
grouped: `[outdent ⇤][indent ⇥] | [undo ↺][redo ↻] | [complete ☑][/]`. It gives thumb-reachable access to the
structural + history actions that on desktop are keyboard shortcuts (`Tab`/`Shift+Tab`, `Mod+Z`/`Mod+Shift+Z`,
`Mod+Enter`) plus the `/` command palette — none of which a software keyboard exposes. Shipped compiled
default ON behind an `isMobileBar()` localStorage escape-hatch flag (the ADR 0019 shape); the flag was
deleted once dogfooded (2026-07-12) — the bar now mounts unconditionally and self-gates on pointer type.

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
- **Position = a measured anchor.** One CSS custom property, `--kb-inset`, written on `<html>` by
  `data/keyboard-inset.ts` from a zero-size `position: fixed; bottom: 0` probe (`styles.css` holds the `0px`
  default). The bar stays `bottom: 0` and lifts by `calc(-1 * var(--kb-inset))`; its safe-area pad SUBTRACTS the
  same inset, because a raised keyboard already covers the home indicator. Both declarations are branchless, and
  the keyboard animation costs zero React re-renders.

**Amended 2026-07-24: the lift cannot be computed from any live viewport property.** This ADR originally
specified `innerHeight - (visualViewport.height + visualViewport.offsetTop)`, computed in a `useKeyboardViewport`
hook. That shipped, dogfooded fine, and was wrong. Three candidate replacements were measured on device, in
order, and each was also wrong:

1. **`window.innerHeight` is not a stable quantity on iOS Safari.** In one simulator session, one page, one
   keyboard, it read **714, 635 and 279** as the page scrolled and the keyboard animated, silently switching
   between describing the layout viewport and the visual one. At the bottom of a long page it collapses to
   equal `visualViewport.height`, which reduces the whole expression to `-offsetTop`: always negative, always
   clamped to zero, so the bar never lifted. That is the bug users hit, and it is bottom-of-page specific
   because that is where the collapse happens.
2. **`documentElement.clientHeight` is not the answer either.** It looked like one — it held 714 across every
   simulator sample while `innerHeight` thrashed — but on a physical iPhone the same instant read
   `innerHeight` **526**, `clientHeight` **498**, and a true pre-keyboard band bottom of **590**. Three
   different answers, and the one that matters is not readable after the keyboard has already opened.
3. **The VirtualKeyboard API's per-focus baseline is also not the answer.** Tried next, via
   [`virtual-keyboard-api-polyfill`](https://github.com/cameronapak/polyfill-virtual-keyboard-api), whose SPEC
   rule 2 captures the visible band at `focusin` and computes
   `remainder = max(0, baselineBottom - vv.height - vv.offsetTop)`. Correct in principle and it committed
   sane-looking values — but its baseline (590) is not the box `bottom: 0` resolves against (498), so it
   over-lifted by exactly that 92px difference. Safari's chrome sits between the two.

The reason all three fail is the same, and it is the finding worth keeping: **iOS Safari moves the box that
`position: fixed; bottom: 0` resolves against, and no property reliably names it.** Across two samples in one
keyboard session, `innerHeight` read 526 then **482** while `clientHeight` stayed 498 and the pre-keyboard band
stayed 590 — nothing else changed. That is why the bar was fine "for the most part" and then suddenly was not:
each formula is correct only while the chrome sits where that formula assumed.

So the anchor is **measured, not computed**. `data/keyboard-inset.ts` appends a zero-size
`position: fixed; bottom: 0` probe and reads its `getBoundingClientRect().bottom`, which is where `bottom: 0`
lands by definition, with no model in between; a client rect is reported in the same space as
`visualViewport.height`, so the lift is their difference. Fed the two samples above it yields the correct 228 in
both, even though the anchor itself measured 418 and 390. Chrome drift is absorbed rather than modelled.

**Why not `env(keyboard-inset-*)` even with a polyfill.** The original rejection was "Chromium-only, and iOS
needs the JS path anyway". A polyfill does close the engine gap, so that premise expired — but the API answers
a different question than we are asking. It reports the keyboard's occlusion of the _visible band_; we need the
distance from _our fixed anchor_, and on a page with browser chrome those differ. The name `--kb-inset` is kept
because it is what consumers mean, but the value is ours.

**Why we blend with iOS's keyboard accessory bar rather than remove it.** On iOS Safari there is **no web API**
to hide or reorder the system keyboard accessory bar (the floating pill with the prev/next-field arrows + a
"Done" check). That control belongs to WebKit; a native app suppresses it via `inputAccessoryView`, the web
has no equivalent, and standalone/PWA mode does not change this. So our bar cannot own that space — a second
full-width bar just _fights_ the system one and reads as two competing strips. Instead the bar is styled as a
**floating frosted-glass capsule** that adopts the accessory pill's shape _grammar_ — inset from the edges,
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

**Why `onPointerDown` + `preventDefault`, but the action fires on `pointerup`.** Tapping a button must not
steal focus from the contentEditable, or the caret and keyboard collapse and the action loses its target.
`preventDefault()` on `pointerdown` keeps the span focused across the tap — **every** button does this, with no
exception now that there is no dismiss button. (Dismissing is delegated to the system: iOS "Done" / Android
back.) But the **action runs on `pointerup`, and only if the finger stayed within a small threshold** of where
it landed: the pill is `overflow-x-auto`, and firing on `pointerdown` meant a horizontal scroll of the strip
triggered whatever button the finger started on. The `preventDefault` stays on `pointerdown` (it preserves
focus and does NOT block the overflow scroll, which is governed by `touch-action`); the tap-vs-scroll split is
the bullet-dot's movement-threshold mechanic (`use-drag-reorder.ts`).

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
- **Computing the lift from a viewport property.** Four attempts, all measured on device, all wrong the same
  way — the anchor moves and the formula does not. Do not re-derive any of these:
  - **`innerHeight`.** Shipped for a year. Not a stable quantity on iOS; collapses to `visualViewport.height`
    at the bottom of a long page, which zeroes the lift entirely. This was the reported bug.
  - **`clientHeight`.** The obvious correction, and stable across every simulator sample — but 92px off the
    real anchor on a physical iPhone.
  - **The VirtualKeyboard API baseline** (native `env(keyboard-inset-*)` or the polyfill). Answers a different
    question: the keyboard's occlusion of the visible band, not the distance from our fixed anchor.
  - **Zero lift (`bottom: 0` alone),** on the theory that Safari already resolves `bottom` against the visible
    band. It does not; the bar landed at 589 against a band of 377.
- **True `/` toggle.** Needs cross-component menu-state observation for a marginal gain over insert-and-open.
- **Per-node reactive button state (enable/disable, checked).** Re-fights the ADR 0014 per-node render budget;
  row-level feedback already tells the user what happened.

**Not e2e-testable → manual iPhone checklist in the PR:** keyboard-relative positioning, `visualViewport`
tracking, iOS contentEditable focus-preservation under `preventDefault`, and how the glass capsule reads
stacked above the system accessory pill — Playwright can't drive a real software keyboard or `visualViewport`
resize, nor render the iOS accessory bar. The e2e suite (`e2e/mobile-actions-bar.spec.ts`) covers the rest:
coarse-only mount, focus/blur visibility, and each button's action wiring.
