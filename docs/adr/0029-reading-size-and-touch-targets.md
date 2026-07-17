---
status: accepted
---

# Reading size preference + touch targets

**What.** Two coupled legibility fixes, deliberately kept as distinct changes under one decision:

1. **Density baseline (global).** The outline row's text (`.node-text`) had no `line-height` and
   inherited the 16px browser default with tight ~1.25 leading (clamped by `min-height: 24px`). The
   new baseline is **17px** with **1.5 leading** and slightly more row padding. This moves the
   _default_ for every user, not just the owner.

2. **A device-local reading-size preference.** Three steps — **Small (~15px) / Default (17px) /
   Large (~19px)** — set via a `data-text-size` attribute on `<html>`, read by CSS through one
   `--reading-font-size` var. It mirrors the theme provider verbatim (`useSyncExternalStore` over
   `localStorage`, no-flash inline script in `__root.tsx`), lives in the header "More" menu next to
   Theme, and persists **per-device in `localStorage`**, NOT synced to the per-user DO.

3. **Touch targets (global).** On coarse pointers the bullet's tappable box grows (it was 16px wide;
   the `touch-hitbox` only ever expanded it _vertically_ to 44px) and rows gain vertical padding, so
   zoom taps and caret taps stop missing on mobile. **The task checkbox reaches the same ~24px on
   coarse (amended later),** but by widening its `touch-hitbox` `::before` 4px per side rather than
   growing the box — see _Why the checkbox widens its hitbox instead of its box_ below.

4. **Right-edge chevron + tap-to-edit (coarse pointer, added later).** A second increment, modelled on
   Workflowy mobile: on coarse pointers the collapse chevron moves from the left gutter to the row's
   **right edge**, and tapping a row's dead space (not just the text glyphs) places a caret. Desktop
   (fine pointer) is untouched — it keeps the left hover-reveal chevron.

**Why a preference at all, and why device-local.** The trigger was the owner running the app at
browser zoom **125%** — Dotflowy-specific, not a global browsing habit — which is whole-UI zoom used
as a blunt instrument for "text too small." A single global default can't satisfy both "don't
oversize the app for users who never complained" and "fully fix a power user who wants 125%": moving
the default all the way overshoots everyone, moving it partway leaves the power user still zooming.
A small preference closes exactly that gap. It is **device-local** because ideal reading size is a
property of the screen in front of you (laptop vs. large monitor), not the account — so it rides the
same `localStorage` shape as `flags.ts` and the theme, and costs no DO write.

**Why the "More" menu, not the sidebar.** A persistent settings sidebar is wanted (theme, plugin
toggles, this) but it is a **separate, larger project** with its own ADR. Gating a legibility fix —
and a genuine mobile touch-target _defect_ — on that framework would hold both hostage. So the
preference ships as a self-contained unit (storage + apply + one radio submenu) whose mechanism the
future sidebar simply re-hosts; the sidebar is not built here.

**Why the decorations align optically, not geometrically.** Every leading
decoration (bullet dot, checkbox, lock, badges, provenance) centers on the text's
**optical center — its x-height midline — not the geometric line-box center**,
which the eye reads as ~2.5px too high because text mass sits low in the line box
(measured near-constant across sizes). Each decoration's `margin-top` is
`calc(var(--reading-line-box) / 2 - Kpx)`: the `/2` term tracks the reading size
so alignment never drifts as the font scales, and K folds in the glyph's
half-height plus that constant optical nudge. Do NOT "simplify" these to a plain
`align-items: center` / geometric centering — it scales but reads high.

**Why 24px, not a full 44px, bullet.** The bullet sits between the collapse chevron (left gutter)
and the text caret (right), 6px away on each side; a 44px-_wide_ target overlaps both and refights
them for taps (the existing CSS comment documents exactly this). Phase 1 grows the bullet to a
pragmatic ~24px on coarse pointers — a large improvement over 16px with zero overlap risk — and
leaves full-width tap routing (e.g. a coarse-pointer row-left hit region) to a later pass.

**Why the checkbox widens its hitbox instead of its box (amended).** The original increment grew the
bullet only; the task checkbox was left at 16px on coarse, and the omission went unnoticed because
shadcn's vendored `ui/checkbox.tsx` shipped an undocumented `after:-inset-x-3 after:-inset-y-2` that
silently inflated it to 40×32. That ::after was **the bug**: the checkbox has exactly 6px of
clearance to the text on its right and 6px to the bullet on its left, so a 12px-per-side arm
overshot by 6px and sat on the first characters of the text — a fine-pointer drag-select starting
there toggled the task instead of placing a caret. It is deleted, and the primitive carries a
comment so a re-sync can't restore it.

The checkbox then reaches 24px the way the chevron does: the width opt-in the `touch-hitbox` comment
already permits, `left/right: -4px` on its `::before`, coarse-only. It does **not** copy the bullet's
`width: 24px`, because the two controls are not alike — the bullet's box is invisible (only a 9px dot
draws inside it), so growing it is free, whereas the checkbox's box **is** the drawn control. Growing
that would fatten the glyph, drop the check's fill ratio from 87% to 58%, shift the text 8px right
(it floats), and pull in the K 4.25 → 8.25 change with its specificity trap. Inflating the ::before
costs no layout and no pixels, and **K stays 4.25 on coarse** precisely because the box never moves.
4px per side is the ceiling — it leaves 2px of daylight on both sides, so the boxes still cannot
overlap and refight for taps.

The rule is **deliberately unscoped**, because a task checkbox renders in **three** surfaces, not two:
the list row, the zoomed title, and quick-add's mini-editor (ADR 0049, which renders the same
`title:before-text` slots). Each earns its 6px of clearance from a **different declaration** —
`.row-body > :not(.node-text)`'s `margin-right` for the first two, `.quick-add-editor`'s
`gap: 0.375rem` for the third — so **all three are load-bearing for the 4px arm**: drop any one below
4px and that surface re-creates this bug locally. That coupling is the price of one unscoped rule; the
alternative (three scoped rules) trades it for three places to forget. Guarded in `e2e/todos.spec.ts`
(fine pointer: the text's first character hit-tests to the text) and `e2e/mobile-touch-rows.spec.ts`
(coarse: the 24px target) — **both on the row only**; the title and quick-add ride the shared selector.

**Why the chevron goes right on touch (increment 4), and how.** Two reasons it belongs on the right,
both Workflowy-mobile-proven: (a) it frees the left gutter to a single, unambiguous thumb target —
the bullet (zoom/drag) — instead of two 6px-apart controls fighting for taps; (b) a right-pinned
chevron forms one clean column at every depth (`<li>` is `width:100%` with depth as
`paddingInlineStart`, so the row's right edge is the viewport edge regardless of nesting). It is
**scoped to `@media (pointer: coarse)`** — a mouse user, even in a narrow window, keeps the left
hover-reveal chevron that Dotflowy's clean-margin desktop aesthetic depends on; pointer type, not
viewport width, is the honest "this is a finger" signal (and it is the seam ADR 0029 already uses).
The move is **CSS-only, no DOM reorder**: `.collapse-toggle` stays first in source order (tab order
sane, both render paths — `OutlineRow` live + `OutlineNode` rollback — move for free off the shared
class) and flips from `left:-15px` to `right:0` under the media query, with `padding-inline-end`
reserved on the row so wrapped text never runs under it. Its `::before` tap target spans full row
height × 44px. On the right edge the chevron also **changes semantics**: the left-gutter glyph is a
tree twisty (collapsed points right, expanded rotates to down), but a right-side disclosure reads as
an **accordion** — so under the media query it points **down when collapsed** ("expand below") and
**up when expanded** ("collapse"), a 180° flip matching the Material/iOS expansion-panel convention
(the user's own framing: "it should be pointing downwards, like an accordion, since it's on the right
side"). Same specificity trap as the bullet margin below: the rotation override is written
`.outline-row .collapse-toggle[data-collapsed="false"] svg` so it out-ranks the base `(0,2,1)` rotate
rule the media query cannot. Guarded by an accordion-direction assertion (reads the rendered transform
matrix, not a class) in `e2e/mobile-touch-rows.spec.ts`. **Vertical-alignment gotcha:** the chevron is `position:absolute`, so its `top` is
measured from `.outline-row`'s _padding_ box, while the bullet and text are flex items measured from
the _content_ box; the desktop `top` calc silently folds in the 2px desktop row padding, so when
coarse padding grows to 6px the chevron rides 4px too high and must add that delta back (`K` 6.25 →
2.25) to re-share the bullet/text optical center. Same reason the coarse bullet's `K` rises 4.25 →
8.25 when its box grows 16 → 24px — **but that coarse bullet margin MUST be written as
`.outline-row .bullet` (0,1,1), not a bare `.bullet` (0,1,0)**: a media query adds no specificity, so
a bare selector silently loses to the base `.outline-row .bullet` optical-align rule and the coarse
offset never lands (the dot drops ~4px, aligned only when DevTools' inspector flips the emulated
pointer back to fine). Keep these tied to the coarse `.outline-row` padding — change one, re-check the
others. Guarded by a numeric alignment assertion in `e2e/mobile-touch-rows.spec.ts`.

_(A companion tweak, obvious from the code so not elaborated here: the `max-w-[720px]` column's
horizontal padding drops 24 → 16px under the `sm` breakpoint via `max-sm:px-4` — width-gated, not
pointer-gated, since it is about screen real estate, and applied to all four column spots (outline +
its fallback, Header, Subheader) so they stay aligned.)_

**Why tap-to-edit, and why on both pointer types.** Tapping the empty band of a row and having
nothing happen is the actual touch frustration (the text glyph is a narrow target); placing a caret
from a dead-space tap is also plain standard-editor behavior (Notion, Workflowy desktop, every code
editor), so scoping it to touch would make _desktop_ feel broken by comparison — hence **both**
pointers. Robustness comes from three choices: it reuses the existing cross-browser `caretFromPoint`
(standard API + WebKit fallback, already used for vertical caret motion); the handler lives on
`.row-body` and guards on **`e.target === e.currentTarget`**, so — because `.row-body` is a block and
the text is an inline `.node-text` span — dead space hits the block _directly_ while text, folded
links, chips, checkboxes, and badges hit those children, excluding every interactive element with no
`closest()` walk; and it touches zero hot-path typing code (one `onClick`, caret via `caretFromPoint`
with an end-of-text fallback). It leaves node drag-select (starts on the text span) and bullet drag
(on the dot) untouched, and focusing this way is consistent with the ADR 0018 selection-exclusivity
model (focus clears a node selection).

**Rejected alternatives.**

- **Bump the global font-size to match 125%.** Overshoots every non-complaining user on n=1 evidence;
  it also would not reproduce 125% (zoom scales the whole layout, a font bump does not) and would
  leave big text in a small frame.
- **Root-rem scale of the whole design system.** Closest to what zoom does, but the codebase has
  arbitrary `px` holdouts (the 720px column, the 13/24px chrome sizes) that would not scale, giving
  a ragged result.
- **Sync the preference to the DO.** Wrong unit of ownership (it is per-screen), and an unnecessary
  write on a value the local device already holds.
