# Week calendar strip: day-to-day navigation in the subheader, seed-free by design

Zoomed on a daily note, switching to yesterday or tomorrow required the Cmd+K
switcher, a date chip, or walking the tree. The fix is a **week calendar strip**
in the subheader: seven day pills for the zoomed day's ISO week, chevron paging,
and one-click navigation between days. Adapted (heavily) from iconiqui's
MIT-licensed week-calendar component; most of that component was deliberately
cut.

## Decisions

1. **The strip is a daily-plugin subheader slot (Seam F) — the seam's first
   plugin consumer.** Not a node slot (it decorates the _view_, not a node), not
   header chrome (it's contextual to one page kind, and the header is
   persistent-actions territory). The slot renders `null` unless the zoom root
   reverse-maps to a `YYYY-MM-DD` day key (`getKeyForNode`), so the band
   collapses everywhere else — day pages only, not week/month/year scaffold
   nodes, where "which day is selected?" has no answer. Always on for day
   nodes; no preference toggle.

2. **Clicking a day is navigation-intent: seed-free get-or-create.** A pill
   click routes through the same `goToDate` path as a `[[date]]` chip click
   (ADR 0038): the day node is minted lazily on first visit, **no seeded entry
   line, no `?focus=last`**. ADR 0041's boundary is untouched — only the three
   write-intent surfaces seed. Browsing ahead to Thursday must not leave a
   stray empty bullet on Thursday.

3. **Monday-start ISO weeks, from `date-links.ts` — never a second date
   library's week math.** The strip's seven days are exactly the day's owning
   `YYYY-Www` scaffold week (ADR 0052), so the strip, the week node's badge,
   and the hierarchy agree on what "this week" means. A Sunday-start strip
   would straddle two week nodes. `date-fns` is already a dependency but the
   ISO helpers (`dayKeyToWeekKey`, `weekKeyToDayRange`) stay the single source
   of week truth.

4. **Most of the source component was cut.** Kept: the seven-pill week row,
   the selection pill, chevron paging. Cut: the grabber handle, the week→month
   morph/grid, drag-and-swipe paging, and the blur dissolve. Cutting ~60% is
   why it's a **purpose-built rewrite inside `src/plugins/daily/`** (with MIT
   attribution) rather than a shadcn vendor into `ui/` + `kit.ts` — vendoring
   would ship dead month-grid code and kit ceremony for a single consumer.
   Styling is dotflowy theme tokens, not the upstream palette.

   **Motion grammar (revised after an animation review):** the strip's chrome
   is **stationary** across a day switch. The selection pill is the **sole
   moving element** — a `layoutId` sliding from the old day to the new one, a
   **tween** on the house curve (`cubic-bezier(0.32, 0.72, 0, 1)`, the zoom
   morph's curve in `styles.css`), not a spring (dotflowy doesn't use springs,
   and the underdamped spring overshot). The week row has **no entrance
   animation** — paging swaps it instantly (the month label + `W29` badge carry
   the change), and a same-week switch is silent chrome. **Navigation from the
   strip is plain, not the zoom morph** (`ctx.nav.open` / `goToDate(…, {morph:
false})`): the clicked day isn't rendered in the outgoing view, so there's
   no element to morph FROM — the pill slide IS the transition, and a zoom
   morph would stack a redundant title pop-in over it. Reduced motion snaps the
   pill and the subheader height, as before. The subheader itself **snaps to
   full height on mount** (it only animates open/close changes made after first
   paint), so the per-day-switch editor remount can't make the band re-open.

5. **Orientation chrome:** a quiet month+year label ("July 2026", the visible
   ISO week's majority month — Thursday's month) plus a `W29` ISO week badge.
   Paging is ephemeral local state (reset on route change); while the visible
   week ≠ the zoomed day's week, a snap-back affordance re-centers the strip —
   **navigation-free**, unlike the header Today button (which navigates and
   seeds).

6. **A day pill's dot means "you wrote something here":** the day key has a
   mapping AND the node has children. Existence alone would light up every
   shell minted by a seed-free peek, decaying the signal into noise.

7. **The seven visible day pills are external structural drop targets.** A
   node dragged from the open Daily note can be dropped on a date to move that
   node and its whole subtree to the destination Daily note's end. A missing
   destination is created seed-free before the move; Undo restores the moved
   nodes but intentionally keeps that empty day, matching "Send to Today."
   The view stays on the source day and confirms with the standard Move toast
   ("Moved to Tuesday, October 6" + **Go**). Same-day drops have the same
   append-or-no-op semantics as "Send to Today." Only the seven visible dates
   participate — chevrons do not page on hover and the strip has no edge paging.

   During drag-over, the outline insertion line is suppressed and the target
   pill uses the chosen **Primary ring** treatment: a 2px monochrome primary
   outline, muted fill, and quiet outer ring, with no chromatic accent. Hit
   testing uses the pointer/finger center against the pill's existing ≥44px
   target; adjacent invisible hit areas would make boundaries ambiguous. An
   unminted day keeps the nodes in place while the existing Daily progress bar
   reports creation. Failure leaves both tree and selection unchanged.

   This is a narrow, generic **external drop-target plugin seam**, not a Daily
   branch in core and not a private global-event bridge. Core owns the pointer
   lifecycle, cancellation, dragged root set, and target arbitration; a
   reviewed compiled-in plugin owns its rendered target, acceptance, active
   styling, and commit. The seam is Lane A only (ADR 0031): it does not allow
   runtime third-party code onto the outline surface.

   If the grabbed row belongs to an active node selection, every selected root
   moves in order as one structural batch and one undo step; all selected rows
   dim, the drag pill keeps the grabbed text plus a count ("Prepare launch
   notes +2"), and success clears selection because the roots left the current
   day. A cancelled or failed drop keeps selection. The existing selection
   actor supplies the root ids, but the established imperative drag lifecycle
   remains imperative — this does not add another XState machine (ADR 0020).

## Consequences

- The subheader band gains ~2 rows of sticky height on every day page. Accepted
  as the day page's identity; the band still collapses on non-day pages.
- The seam-F subheader table in `AGENTS.md` gains its first plugin owner.
- The strip lives in ONE render path (chrome), so the bullet/title/mini-editor
  duality trap does not apply.
- External drop targets become a reviewed plugin capability. The first
  consumer is Daily; ordinary outline gaps keep their existing projection and
  indicator, while an active external target takes precedence.
- `goToDate` gained a second in-plugin caller, and the strip↔`index.tsx`
  import cycle it forced was real — so the whole get-or-create engine
  (`getOrCreateDay`/`goToDate` + the scaffold cascade/migration) moved to
  `get-or-create.ts`, a behavior-identical extraction (verified against the old
  bodies in review) save for the one deliberate addition: `goToDate` gained the
  `morph` option the strip needs for its plain (non-morph) navigation.
  `index.tsx` keeps only the `protects` seam and re-exports `getOrCreateDay` for
  `routes/today.tsx`.
