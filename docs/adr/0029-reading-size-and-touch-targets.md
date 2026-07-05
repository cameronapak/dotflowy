---
status: accepted
---

# Reading size preference + touch targets

**What.** Two coupled legibility fixes, deliberately kept as distinct changes under one decision:

1. **Density baseline (global).** The outline row's text (`.node-text`) had no `line-height` and
   inherited the 16px browser default with tight ~1.25 leading (clamped by `min-height: 24px`). The
   new baseline is **17px** with **1.5 leading** and slightly more row padding. This moves the
   *default* for every user, not just the owner.

2. **A device-local reading-size preference.** Three steps — **Small (~15px) / Default (17px) /
   Large (~19px)** — set via a `data-text-size` attribute on `<html>`, read by CSS through one
   `--reading-font-size` var. It mirrors the theme provider verbatim (`useSyncExternalStore` over
   `localStorage`, no-flash inline script in `__root.tsx`), lives in the header "More" menu next to
   Theme, and persists **per-device in `localStorage`**, NOT synced to the per-user DO.

3. **Touch targets (global).** On coarse pointers the bullet's tappable box grows (it was 16px wide;
   the `touch-hitbox` only ever expanded it *vertically* to 44px) and rows gain vertical padding, so
   zoom taps and caret taps stop missing on mobile.

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
and a genuine mobile touch-target *defect* — on that framework would hold both hostage. So the
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
and the text caret (right), 6px away on each side; a 44px-*wide* target overlaps both and refights
them for taps (the existing CSS comment documents exactly this). Phase 1 grows the bullet to a
pragmatic ~24px on coarse pointers — a large improvement over 16px with zero overlap risk — and
leaves full-width tap routing (e.g. a coarse-pointer row-left hit region) to a later pass.

**Rejected alternatives.**
- **Bump the global font-size to match 125%.** Overshoots every non-complaining user on n=1 evidence;
  it also would not reproduce 125% (zoom scales the whole layout, a font bump does not) and would
  leave big text in a small frame.
- **Root-rem scale of the whole design system.** Closest to what zoom does, but the codebase has
  arbitrary `px` holdouts (the 720px column, the 13/24px chrome sizes) that would not scale, giving
  a ragged result.
- **Sync the preference to the DO.** Wrong unit of ownership (it is per-screen), and an unnecessary
  write on a value the local device already holds.
