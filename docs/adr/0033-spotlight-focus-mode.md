---
status: accepted
---

# Spotlight focus mode

**What.** An opt-in view mode that dims the outline to 0.3 opacity while a bullet is being edited,
**except the single focused bullet**, which stays full — so the line you're on stands out. Toggled from
the header More menu ("Spotlight mode"), default OFF, persisted per-browser in `localStorage`. Dimming is
live only while a bullet holds the caret; the moment nothing is focused, the whole outline returns to full
opacity. Scoped to `.outline-row` content — the header, subheader, and zoomed page title never dim (they
are context, not content).

**Why single-node, not the focused node + its ancestor chain (the UX call).** An earlier draft lit the
active *branch* (focused bullet + every ancestor up to the zoom root). We dropped the ancestors. Dimmed
context at 0.3 is still legible, so lighting the ancestors doesn't *add* context you'd otherwise lose — it
only dilutes the focus and produces a "ladder" of full-opacity rows (node + each parent) interleaved with
dimmed siblings, which reads busier than one crisp bright line against a uniform dim field. For a *focus*
mode, the calmer single line is the point, and it matches the intent ("mainly focus on the current node").
If deep trees ever feel unmoored, the graceful upgrade is a **three-tier gradient** (active 1.0, ancestors
~0.6, rest 0.3), NOT full-bright ancestors — recorded here so the next reach is the gradient, not a revert.

**Why the dim is pure CSS (the load-bearing decision).** Dropping ancestors is what makes this a CSS-only
effect. Single-node lighting is exactly `:focus-within`, and "dim only while a caret is in the outline" is
exactly `:has(.node-text:focus)`:

```css
.spotlight-on:has(.node-text:focus) .outline-row { opacity: 0.3; }
.spotlight-on li[data-node-id]:focus-within > .outline-row { opacity: 1; }
```

So there is **no JS in the dim path at all** — no focus listeners, no generated stylesheet, no tree walk.
The only JavaScript is the engine (`src/data/spotlight.ts`) toggling two `<body>` classes: `spotlight-on`
(the mode, driven by the `localStorage` toggle via a `SpotlightController` mounted at the root) and
`spotlight-fade` (the input modality, below). At rest — nothing focused — `:has` fails and the outline is
full; node **multi-selection mode needs no special-casing** because it has no caret by construction
(ADR 0018), so `:has(:focus)` is already false and its own tint carries focus.

**Transition is input-modality-aware.** Keyboard navigation snaps instantly; a pointer click eases (~120ms
opacity fade). A global `keydown`/`pointerdown` capture listener adds/removes `spotlight-fade` on `<body>`,
and the CSS gates the transition on that class. Rationale: rapid arrow-key nav through bullets must feel
immediate, but a deliberate click into a distant node can afford a soft fade. `prefers-reduced-motion`
forces instant regardless. Dim = 0.3 is a single tunable CSS value.

**Why per-browser `localStorage`, not a synced setting.** Spotlight is an ephemeral view preference, not
user data. Syncing it across devices would mean a new `/api/kv` side-collection + Effect Schema + wiring for
a toggle whose value rarely needs to follow the user. `localStorage` is the right weight; promotion to a
synced settings collection is a clean later move. It is a real user toggle, **not** a `dotflowy:flag:*` dev
flag — those are default-ON rollback hatches deleted after dogfooding; this is default-OFF and persists.

**Rejected alternatives.**
- **Ancestor-chain (active + parents) lit.** Busier "ladder" look that dilutes focus; the dimmed parents
  are already legible at 0.3, so it buys little. The three-tier gradient is the fallback if context is ever
  needed, not this.
- **Generated stylesheet keyed on `data-node-id` + `focusin`/`focusout` listeners (a la `TagColorStyles`).**
  This was the right tool *while* the design lit ancestors — a flat, non-nested list (ADR 0019) can't reach
  ancestors with a CSS descendant selector, so it needed a JS tree-walk emitting an explicit id list.
  Single-node removed that need entirely, and pure CSS is simpler, has no client/DO drift surface, and can't
  fall out of sync with the DOM. Kept in git history, not the code.
- **Focused-id in React state, dim per row.** Re-fights the per-node render budget (ADR 0014): focus changes
  on every caret move, so this would re-render rows on each arrow-step.
- **Synced setting.** Overweight for an ephemeral view preference (see above).
- **A `dotflowy:flag:*` dev flag.** Wrong lifecycle: this is a permanent opt-in mode, not a rollback hatch.
- **Typewriter (center-scroll the active line).** A separate effect (scroll management, fights the
  virtualizer) that composes with but shares no code with spotlight; deferred to its own ADR.
