---
status: accepted
---

# Spotlight breathing room and centering

**What.** While spotlight mode is on (ADR 0033), two motion rules apply:

1. **Breathing room.** The outline region gains `50vh` of padding above the
   list, mirroring the `50vh` margin that has always hung below it. A short
   outline floats near the vertical center of the viewport instead of hugging
   the header. The class carries NO CSS transition; the grow/collapse on
   toggle is the engine's breath tween (below).
2. **Centering.** A focused list row slides to the vertical center of the
   viewport. The zoomed page title (an `h2`, not a list row) centers too when
   it holds the caret — focusing it is explicit intent, and the children come
   back the moment a child is focused. Additionally, zooming into a node with
   **no children** slides the title to center: a lone title at the top of an
   empty page is exactly the "hugging the header" feeling breathing room
   exists to fix. A zoom WITH children keeps the title at the top, because the
   children are the content.
3. **The breath tween: padding and scroll animate as ONE thing.** On toggle,
   a single rAF tween drives the region's inline `padding-top` AND the window
   scroll in the same frames, so the row the user is anchored to stays glued
   to the screen while the page eases into its new shape. Two separate
   animations (a CSS padding transition plus a scroll tween) always fight —
   whichever lands first yanks the other's target — and that fight was the
   "bounce," in both forms we tried: running them concurrently, and
   sequencing them (grow, wait, then slide — the row still wobbled down then
   up). Mechanics: the engine pins the pre-toggle pad as an inline override
   in a LAYOUT effect (pre-paint, so the class flip never flashes a wrong
   frame), tweens to the steady value, then clears the inline style so the
   class (present or absent) takes over at the same number. Scroll anchoring
   is suppressed on the region for the flight — it "compensates" the
   concurrent layout change with a one-frame counter-jump.
4. **Enabling lands the caret.** Spotlight on always leaves a lit line. A
   node already holding DOM focus keeps it, selection untouched. When no node
   holds focus (the More-menu click moved it to the button on the way to the
   toggle), the zoom root's title — else the first visible row — gets the
   caret at line start; the landing lives in OutlineEditor because only it
   knows the true first row (a DOM query finds the first _mounted_ row, which
   mid-scroll is a middle bullet), and an off-window first row rides the same
   pendingFocus mount-claim path a structural edit uses. The breath tween's
   scroll delta centers whatever landed. Mounting with the mode already on
   (page load) skips the animation and snaps to the steady state — an initial
   render does not transition.
5. **Disabling with no lit line scrolls to the top.** The menu path leaves no
   node in focus, and the collapsed padding would strand the viewport deep in
   the page — which reads as "lost": the breath tween collapses the pad and
   glides to `scrollY 0` in the same motion. A node still holding focus
   anchors the view — the scroll tracks the collapsing pad so the lit line
   stays glued — and it stays put.

**Why static spacing first.** An earlier attempt (the original ADR 0060,
PR #340) slid the focused row to center on every focus with ~900 lines of
machinery: half-viewport virtualizer padding wells so edge rows could reach
center, compensating scrolls on mount/toggle/zoom, and a pointer-gesture state
machine to avoid yanking drag-selects. It was reverted before the next release.
Breathing room is what survived: it never moves content relative to other
content, so the parent-child cluster on screen stays intact — and in an
outliner that relationship is the product.

**Why centering came back, but small.** With breathing room alone, focusing a
row mid-list in a tall outline left it wherever the scroll happened to be —
keyboard users lost the "my line lives in the middle" anchor. The centering is
back with every piece of machinery that made #340 heavy removed:

- **No padding wells.** First and last rows clamp at scroll bounds; they sit as
  close to center as the page allows. Accepted.
- **No compensating scrolls.** Mount, toggle, and zoom do nothing special.
- **No pointer state machine.** The drag-select guard is a check at scroll
  time: if the selection inside the row is non-collapsed, skip. A few lines,
  not a gesture tracker.
- **No `visualViewport` resize handling.** The rect is read fresh per focus.

**The modality split (reused from the dim, ADR 0033).** The dim eases on
pointer focus and snaps on keyboard nav; centering rides the same
`spotlight-fade` modality class. A pointer jump eases ~200ms — a deliberate
click can afford the travel. Keyboard takes a short ~120ms beat, so fast
arrowing chases the caret without swimming; each new focus cancels the
in-flight tween and retargets. Keyboard moves (Cmd+Shift+Up/Down) center the
moved row explicitly: a move-up can reuse the DOM span, so focus never leaves
and no `focusin` fires — the move commands schedule the centering themselves,
two frames out, and the focusin path covers every other focus change.
`prefers-reduced-motion` snaps. The keyboard
duration is one constant (`KEYBOARD_SLIDE_MS`); if 120ms ever feels slow, the
fix is that constant, not a redesign.

**Consequences accepted.**

- Focusing a child in a tall list can scroll its parent out of view. This was
  the original complaint against #340; it is accepted here as the cost of the
  anchor, since the breathing room keeps short outlines — the common case —
  intact, and the dim keeps context legible.
- No new tests. The behavior is a scroll delta and a tween; the e2e dim suite
  covers the toggle lifecycle.

**Rejected alternatives.**

- **PR #340's full machinery.** Reverted; see above.
- **`scrollIntoView` / `virtualizer.scrollToIndex` variants.** Unreliable on
  the absolutely-positioned windowed rows (ADR 0019) / estimate-based.
- **Browser-native `scrollTo({ behavior: "smooth" })`.** Browser-timed and not
  interruptible; the rAF tween retargets on the next arrow.
- **Sequenced animations (grow, wait, then slide).** The second attempt: hold
  centering until the CSS padding transition settles, then one slide. Removed
  scroll-fighting but the ROW still wobbled — padding pushed it down the
  screen, then the slide pulled it back up. Replaced by the breath tween.
- **Unconditional breathing room (spotlight-off too).** Considered — it may be
  a plain layout improvement — but kept gated so spotlight stays "the calmer
  mode." Ungating later is a one-line change.
