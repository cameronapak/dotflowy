---
status: accepted
---

# Find goes somewhere, Filter stays put

Cam chose Find + filter after reviewing three interactive directions, then
approved the proposed details. The magnifier and Cmd+K open the same Find
palette. Cmd+F, the desktop funnel, and mobile's Filter this view keep the
editable outline in place. This amends [0034](./0034-cmd-k-command-center.md),
[0047](./0047-query-filter-grammar.md), and [0048](./0048-saved-filter-queries.md).
Mobile keeps [0076](./0076-mobile-navigation-dock.md)'s Search door, with Find
presented in the existing native sheet below 768px. Find uses the package's
large detent to leave room for results above the keyboard; other sheets keep
their existing detents ([0066](./0066-narrow-screen-menu-drawers.md)).

## Decisions

1. Plain words retain fuzzy node matching and command discovery. A query with
   a tag, alphabetic `key:`, leading `-`, quotes, or uppercase standalone `OR`
   switches node matching to DQL and hides main-list commands. The caption says
   only "Everywhere": Cam rejected DQL, exact, and fuzzy terminology in the UI.
   DQL reuses the parser and registered operators, including their unknown-operator
   text fallback.
2. Matches inside the current node come first, labelled "here". A source mirrored
   into the current node is nearby too. Both matching modes return source rows,
   not duplicate mirror instances; this is a navigation list, unlike the editable
   Filter view or agent search. Each partition preserves fuzzy rank or DQL outline
   order. Home has no privileged partition. Search covers collapsed and completed
   content independently of view settings. The guarded query walker resolves mirror
   content and caps cyclic expansion. An empty quoted phrase or unfinished quote
   with no parsed terms returns no Find results.
3. Find renders the first 50 node matches. For a structured query with more than
   50 matches, its last row offers Filter Home, exposing the shared predicate
   through the editable outline rather than an ever-growing modal. Plain-word
   searches do not offer that overflow handoff: their typo-tolerant matches can
   differ from Filter's literal substring matches. Shift+Enter and Filter in
   place remain available for every query and apply it to the current route.
4. Tag clicks continue adding terms to the local filter. Empty Filter uses the
   Find + fixes design: a place-specific heading, plain-language explanation,
   primary Find everywhere action, and a short recovery list. Find opens with the
   query prefilled without changing the view first. Show completed appears only
   when enabling the existing setting reveals matches. Up to two Remove term
   suggestions rank by positive result count, excluding OR and adjacent operands.
   Clear filter always finishes the list. Counts use the same scoped view-filter
   path, hide rules, and mirror behavior as the outline, only while empty.
5. Selecting a saved query in Find fills the palette without navigating.
   Shift+Enter applies it locally. Selecting one from the filter popover still
   applies it locally. Saved data remains query-only, with no storage migration.
6. Desktop shows the magnifier and funnel instead of magnifier and command
   symbol. Find's tooltip advertises Cmd+K. The funnel retains the filter's
   open/active toggle states. No extra mobile toolbar icon is added.
7. A Find node result opens unfiltered. Its origin route and filter remain in
   browser history; the destination carries only the query and selected result.
   Back to search returns to the origin by going back one history entry, then
   reopens Find with that query and selection. It does not replace the destination with a duplicate origin.
   Other navigation does not attach this return affordance. No persistent search state or URL
   search scope is introduced.
8. Both surfaces offer To-do, Completed, Tag, Highlight, Has link, and Has children
   shortcuts. Each opens an explicit include/exclude/remove menu, not a repeated-click
   cycle. Completed offers Any, Completed, and Not completed. Active tags offer
   Include tag, Exclude tag, and Remove filter. A choice replaces the opposite
   term instead of adding contradictory conditions. Chips show the active state
   and write visible query text, never hidden filters. Tag and Highlight expose
   suggestions from the existing corpus and operator metadata. `has:children`
   tests direct children of resolved content, including collapsed or completed
   children. Phone shortcut menus portal into the native sheet so they remain
   interactive. Filtering stays a plain input; Find uses its command list for suggestions.
9. The uncommitted Everywhere / This node design is replaced, not shipped:
   no scope toggle, `scope=everywhere`, or separate global results page. Find
   retains the command center's existing node-action sub-view and protected
   mutation paths. Results navigate; completing a node stays in its Actions.

## Trade-offs and boundaries

A visible syntax-dependent matching switch preserves typo tolerance but can
surprise users as they start typing an operator. Text-producing chips teach the
query syntax, but the caption intentionally avoids matching terminology. A 50-result cap keeps the palette bounded;
large DQL sets belong in the editable outline. Nearby ordering is a stable
partition, not a second matching algorithm. Full-index matching runs only while
Find is open, not while writing in the outline. Large-outline latency is not a
new performance guarantee.

The scope-toggle alternative coupled scope changes to a change of page layout.
Nearby first removed the toggle but kept a separate global results page.
Reusing Find avoids both and preserves the existing navigation/filter boundary.
Native-sheet focus handoffs wait for close before navigating or opening Filter;
desktop retains the command dialog's final-focus boundary. Cam requested smooth
desktop height changes after trying the preview. Opening and selection remain
instant; a 160ms, interruptible ease-out translates the popup and scales only
its separate backplate when results change, revealing content with a synchronized
clip so rows never extend beyond the growing surface. Text is never scaled, and no height
or top property animates per frame. Reduced motion skips the resize. This is a
requested exception to the motion review skill's usual no-motion rule for
keyboard-driven palettes. Other command dialogs and the phone sheet keep their
existing motion. Both local filter controls use a funnel icon, and the empty
filter's Find everywhere action uses the primary button variant. Text-selection Cmd+K
still belongs to the editor's create-link shortcut, per ADR 0034.

Verification covers fuzzy versus exact results, nearby ordering before the cap,
saved queries, chips and suggestions, filter handoff, return selection, node
commands, and desktop/mobile rendering. Device emulation does not prove real
phone keyboard animation or screen-reader behavior.
