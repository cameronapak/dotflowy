# Header toggle buttons: solid means the view is altered, muted means engaged

The header's right cluster holds several icon toggles (spotlight, bookmark, the filter magnifier). They were drifting toward inconsistent "on" treatments, so we fixed the meaning rather than the pixels: **solid `--primary` = the view you're looking at is altered right now; muted `bg-muted` = a toggle is engaged but the view is still normal.** One rule decides every header toggle's active look.

## The rule

| Control                | "On" state               | View altered?          | Treatment                            |
| ---------------------- | ------------------------ | ---------------------- | ------------------------------------ |
| Spotlight (ADR 0033)   | mode on                  | yes — everything dims  | **solid** `variant="default"`        |
| Filter magnifier       | a `?q=` query is applied | yes — nodes are hidden | **solid** `variant="default"`        |
| Filter magnifier       | input open, no query yet | no                     | **muted** `bg-muted text-foreground` |
| Bookmark star          | current view pinned      | no — it just saves     | **muted** `bg-muted` + filled icon   |
| ⌘ command center, More | — (opens a dialog/menu)  | no                     | ghost only (no pressed state)        |

Read it as: **solid answers "why does my outline look different?"** (dimmed, or pruned) — a surprising, persistent state you can scroll away from and forget. **Muted answers "is this tool engaged?"** — low-stakes, and usually corroborated by adjacent chrome (the open input, a filled star).

## Why not the two obvious one-rule alternatives

- **Grey everything** (the first instinct when solid-on-open feels too loud): demotes "your view is filtered" to the same weak signal as "the box is open." A filtered outline with the input scrolled out of sight is exactly the state that needs to shout. Rejected.
- **Solid everything, tied to open:** opening an empty search box would shout as loudly as an applied filter, and two solid-black pills could sit in the header at once. Overweights transient, low-stakes states. Rejected.

The magnifier therefore carries **three** states (ghost → muted → solid), which is the whole point: the emphasis tracks the stakes.

## Consequences

- The magnifier's "open" state must be observable outside `QueryFilterBar` (whose `summoned` flag is local `useState`). `query-filter-nav.ts` gains a `useSyncExternalStore`-backed open-signal (the `spotlight-mode` / `show-completed` pattern); `FilterButton` subscribes. `aria-pressed` now reflects "the input is open" (open ∨ applied), not just "a query is applied".
- **The magnifier has no filled-icon variant** the way the bookmark/pin do, so `bg-muted` alone carries its muted state — and `bg-muted` is the same color as the ghost `hover:bg-muted`. Accepted because the muted state is transient (you're about to type) and the open input below disambiguates; if it ever reads as invisible, add a subtle inset ring rather than reaching for solid.
- No shadcn `Toggle` primitive: the house `Button` + `data-state`/`aria-pressed` pattern (BookmarkStar) already expresses this; a second primitive would be redundant. Spotlight and bookmark already conformed and were left untouched — this ADR mostly _names_ an existing rule and fills the one gap (the magnifier's missing open state).
