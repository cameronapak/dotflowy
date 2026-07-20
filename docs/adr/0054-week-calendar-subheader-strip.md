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
   the spring-animated selection pill, chevron paging. Cut: the grabber
   handle, the week→month morph/grid, drag-and-swipe paging, and the blur
   dissolve (paging gets a quiet fade/slide, instant under
   `prefers-reduced-motion`). Cutting ~60% is why it's a **purpose-built
   rewrite inside `src/plugins/daily/`** (with MIT attribution) rather than a
   shadcn vendor into `ui/` + `kit.ts` — vendoring would ship dead month-grid
   code and kit ceremony for a single consumer. Styling is dotflowy theme
   tokens, not the upstream palette.

5. **Orientation chrome:** a quiet month+year label ("July 2026", the visible
   ISO week's majority month — Thursday's month) plus a `W29` ISO week badge.
   Paging is ephemeral local state (reset on route change); while the visible
   week ≠ the zoomed day's week, a snap-back affordance re-centers the strip —
   **navigation-free**, unlike the header Today button (which navigates and
   seeds).

6. **A day pill's dot means "you wrote something here":** the day key has a
   mapping AND the node has children. Existence alone would light up every
   shell minted by a seed-free peek, decaying the signal into noise.

## Consequences

- The subheader band gains ~2 rows of sticky height on every day page. Accepted
  as the day page's identity; the band still collapses on non-day pages.
- The seam-F subheader table in `AGENTS.md` gains its first plugin owner.
- The strip lives in ONE render path (chrome), so the bullet/title/mini-editor
  duality trap does not apply.
- `goToDate` gains a second in-plugin caller; if that forces an import cycle
  with the plugin's `index.tsx`, the nav helper moves to its own module —
  semantics stay identical.
