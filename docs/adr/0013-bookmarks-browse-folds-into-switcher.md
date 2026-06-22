# ADR 0013: Bookmarks browse folds into the quick-switcher (remove header popover)

Status: accepted (2026-06-22), implemented. Supersedes the **Bookmarks popover** decision
in [ADR 0011](./0011-bookmarks-via-header-popover.md); the rest of 0011 (data model, the star,
no-sidebar) stands.

## Glossary

- **Bookmarks popover** (removed) — the header **Bookmarks** button that opened a panel listing
  every bookmarked node, newest-first. Defined in ADR 0011, deleted here.
- **Quick-switcher empty state** — what the Cmd+K switcher shows before you type: the bookmarks,
  newest-first (ADR 0012). The *same list the popover showed*, by the *same sort*.
- **Star** (kept) — the header toggle that pins/unpins the current zoom view. Unaffected: it is
  bookmark **creation**, which the switcher does not do.

## Decision

Remove the **Bookmarks popover** from the header. Browsing bookmarks now happens in the **node
quick-switcher's empty state** (ADR 0012), which already lists them newest-first. The **star**
stays.

## Why

- **Two surfaces showed the same list.** The popover and the switcher's empty state both render
  "bookmarks, `bookmarkedAt` descending." Once the switcher shipped (ADR 0012), the popover was
  a second door to one room. Cutting it removes a header control and a `Popover` mount for zero
  capability loss.
- **The split that justified two controls collapsed.** ADR 0011 separated **create** (star) from
  **browse** (popover). Browse moved into the switcher; only create is left without another home,
  so only the star needs to stay in the header.
- **Browsing is still one keystroke.** Cmd+K (or the header magnifier on touch) opens the
  switcher; bookmarks are right there before you type. No deeper than clicking a Bookmarks button.
- **Simpler header.** The right cluster drops from five controls to four: star · search ·
  show-completed · theme.

### What this does NOT change

- **The data model.** Still `bookmarkedAt: number | null` on the node; no migration.
- **The star.** Still pins/unpins the current view, still hidden on home. It now also **owns its
  trailing divider** in code (it always did in ADR 0011's prose, but the divider had been a literal
  in `Header`, so it dangled on home — fixed here as a side effect of the cluster edit).
- **No sidebar.** ADR 0011's promotion trigger is untouched; `ui/sidebar.tsx` stays as the
  documented path for a future second nav tenant.

## Rejected alternatives

- **Keep both surfaces.** Rejected: redundant. A dedicated button is marginally more discoverable
  than "open search to see bookmarks," but not enough to justify a permanent header control that
  duplicates the switcher.
- **Remove the star too.** Rejected: the switcher only *browses*; nothing else *creates* a
  bookmark. Removing the star would leave no way to pin a view.
- **Move bookmark browsing to a sidebar instead.** Out of scope and against ADR 0011's no-sidebar
  stance; the promotion trigger (a second real nav tenant) hasn't fired.

## Known rough edges

- **Discoverability leans on the switcher.** A first-time user no longer sees a "Bookmarks" label
  in the header; they discover the list by opening search. Acceptable given how central Cmd+K is.
- **No test runner** (AGENTS.md). `typecheck` is the only static gate. Walk by hand: header no
  longer shows a Bookmarks button; star still pins/unpins on a zoomed node and is absent on home
  with no dangling divider; Cmd+K empty state still lists bookmarks newest-first.

## What changed

- **`src/components/bookmarks.tsx`** — `BookmarksMenu` deleted; its now-dead imports
  (`useMemo`, `useState`, `useLiveQuery`, `Link`, `nodesCollection`, `Bookmark`, `Popover*`)
  removed. `BookmarkStar` now renders the star **plus its trailing `Separator`** (fragment), so
  the divider truly appears/disappears with the star.
- **`src/components/Header.tsx`** — dropped `<BookmarksMenu />` and the literal
  `<Separator>` (now owned by the star) and their imports. Right cluster: `BookmarkStar` ·
  `NodeSearchButton` · `ShowCompletedToggle` · `ModeToggle`.
- **`docs/adr/0011`** — top note marking the popover decision superseded by this ADR.
- **`AGENTS.md`** — Bookmarks section updated: browse lives in the switcher, header has the star
  only.
