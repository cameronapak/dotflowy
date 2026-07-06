---
status: accepted
---

# Spotlight focus mode

**What.** An opt-in view mode that dims the outline to 0.3 opacity except the **active branch** — the
focused bullet plus its ancestor chain up to the current zoom root, which stay at full opacity — so the
line you are editing and its context stand out. Toggled from the header More menu ("Spotlight mode"),
default OFF, persisted per-browser in `localStorage`. Dimming is live only while a bullet holds the
caret; the moment nothing is focused, the whole outline returns to full opacity. Scoped to `.outline-row`
content — the header, subheader, and zoomed page title never dim (they are context, not content).

**Why a generated stylesheet, not React state (the load-bearing decision).** The dim is painted by ONE
generated `<style>` tag keyed on `data-node-id`, regenerated on each focus change — the exact mechanism
`TagColorStyles` uses (ADR 0007):

```css
.spotlight-on .outline-row { opacity: 0.3; }
.spotlight-on li[data-node-id="<active>"],
.spotlight-on li[data-node-id="<ancestor>"] { opacity: 1; }
```

Two constraints force this over the obvious "track the focused id in React and dim per row":

- **The ADR 0014 render budget.** Focus changes on every caret move (every arrow-nav across bullets).
  Re-rendering rows on each focus change to flip an `opacity` prop re-fights the per-node render budget
  the whole editor is built to protect. A stylesheet write is O(1) and touches zero React.
- **The flat windowed list has no DOM nesting (ADR 0019).** Two independent knock-ons:
  1. "Ancestors" are not DOM ancestors, so a CSS descendant selector cannot express "active + its
     parents." The lit set is computed in JS (walk `getTreeIndex()` parents to `viewRootId`) and emitted
     as an explicit id list. This is also why pure `:not(.is-active)` — which *would* handle the
     active-line-only case — was rejected the moment we chose ancestor-chain lighting.
  2. The virtualizer mounts/unmounts rows on scroll. A class toggled onto a row's DOM node now vanishes
     when that row recycles, and a freshly-scrolled-in row would need re-tagging on mount. A rule keyed
     on `data-node-id` needs neither — a row that scrolls into view already matches the standing rule.

**Signal.** A document `focusin`/`focusout` listener (the `MobileActionsBar` `useOutlineEditing` pattern),
active only while the mode is on. `focusin` within an outline span → `findFocusedId()` → walk the ancestor
chain → regenerate the stylesheet. `focusout` (rAF-deferred, as `useOutlineEditing` does, to survive the
focus hop between bullets) with nothing focused → drop `.spotlight-on` → everything returns to 1.0. This
is why node **multi-selection mode needs no special-casing**: it has no caret by construction (ADR 0018),
so the resting state applies and the selection's own tint carries focus.

**Transition is input-modality-aware.** Keyboard navigation snaps instantly (`transition: none`); a pointer
click eases (~120ms opacity fade). A global `keydown`/`pointerdown` capture listener records the last input
type (the same signal `:focus-visible` keys on) and the stylesheet write toggles the transition accordingly.
Rationale: rapid arrow-key nav through many bullets must feel immediate, but a deliberate click into a
distant node can afford a soft fade. `prefers-reduced-motion` forces instant regardless. Dim = 0.3 is a
single tunable CSS value.

**Why per-browser `localStorage`, not a synced setting.** Spotlight is an ephemeral view preference, not
user data. Syncing it across devices would mean a new `/api/kv` side-collection + Effect Schema + wiring
(the tag-colors shape) for a toggle whose value rarely needs to follow the user. `localStorage` is the
right weight; promotion to a synced settings collection is a clean later move if it earns it. It is a real
user toggle, **not** a `dotflowy:flag:*` dev flag — those are default-ON rollback hatches deleted after
dogfooding; this is default-OFF and meant to persist.

**v1 simplifications (deliberate).**
- A node mirrored at two paths (ADR 0022) lights up at both instances — the rule keys on `data-node-id`,
  which every instance of a node shares. Acceptable; per-instance lighting would need path-keyed rows.
- The ancestor walk uses the `TreeIndex` parent chain, not the exact visible mirror path. Good enough for
  a dim cue; exact-path resolution is a later refinement, not a v1 blocker.

**Rejected alternatives.**
- **Focused-id in React state, dim per row.** Re-fights the ADR 0014 render budget on every caret move.
- **Toggle a class on DOM rows.** Breaks under the virtualizer's mount/unmount churn.
- **Pure `:not(.is-active)` CSS.** Only expresses active-line-only; cannot light the ancestor chain in a
  flat, non-nested list.
- **Active-line-only lit set.** Rejected in design — dimming *all* context (even at 0.3) costs the sense of
  place an outliner needs; the ancestor breadcrumb is cheap to keep.
- **Synced setting.** Overweight for an ephemeral view preference (see above).
- **A `dotflowy:flag:*` dev flag.** Wrong lifecycle: this is a permanent opt-in mode, not a rollback hatch.
- **Typewriter (center-scroll the active line).** A separate effect (scroll management, fights the
  virtualizer) that composes with but shares no code with spotlight; deferred to its own ADR.
