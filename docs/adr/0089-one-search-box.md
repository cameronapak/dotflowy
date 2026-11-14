---
status: accepted
---

# One search box: Find searches here and everywhere at once

Cam found Find (Cmd+K) and Filter (Cmd+F, the funnel) confusing: two boxes that
look alike and behave differently. He explored three directions, chose the
**scope rail** after trying a working demo, and approved it for release. Find is
now the only search box. It shows matches in the current node and everywhere
else in one list, runs commands, and hands a query to the outline when you want
to keep working in the filtered view. This amends
[0083](./0083-find-and-filter.md), [0047](./0047-query-filter-grammar.md) §6,
[0048](./0048-saved-filter-queries.md), [0050](./0050-header-toggle-button-states.md),
[0072](./0072-split-header-view-and-app-menus.md), and
[0076](./0076-mobile-navigation-dock.md).

## Decisions

1. **Every query shows both places.** Results split into **In this node · n**
   and **Everywhere else · n**, in that order, each keeping fuzzy rank or DQL
   outline order (0083 #2's nearby partition, now visible as headings instead
   of a "here" label). The 50-row cap applies after that partition; when this
   node fills it, a line still counts what is left everywhere else. At Home
   there is no narrower place, so one **Nodes · n** section lists everything. Commands stay mixed into the same list, in their
   own **Commands** section, with no `>` prefix. Cam asked for the robust
   choice; a prefix would hide commands from people who never learn it.
2. **Scope only shortens the list.** Desktop shows a left rail: **Search in**
   (Everywhere, This node, Commands, each with a live count), **Narrow** (0083
   #8's six include/exclude shortcuts, stacked), and **Saved**. Phones show
   scope tabs and the horizontal shortcut row instead; on phones they scroll
   away with the results so a short keyboard viewport keeps room for rows.
   Rail, tab, saved, and footer controls keep Enter and Tab for themselves
   instead of running the highlighted row. Choosing a scope never
   changes the layout, which keeps 0083 #9's rejection of a mode toggle that
   swaps pages. The scope label is the generic "This node", not the node's
   name: Cam found the node's name harder to read at a glance.
3. **Show in outline replaces the resident filter input.** Shift+Enter, or the
   **Show in outline** button (the desktop footer, or beside the phone scope
   tabs, whenever there is a query), writes `?q=` for the current route, closes
   Find, and focuses the pill. The filter semantics, recovery, retention,
   and mirror rules in 0047 and 0083 #4 are unchanged. An emptied query clears
   `?q=`.
4. **A pill keeps the applied filter visible.** While `?q=` is set, the
   subheader shows a pill: funnel, the raw query, "in this node" (or "in Home"),
   a pin, and a clear X. The outline stays live and editable underneath; the
   pill stays until cleared. Clicking it reopens Find on This node with the query
   prefilled. Window Escape still clears an active filter in one press.
5. **Cmd+F opens Find on this node.** Virtualization still breaks native find
   (0047 §6), so the shortcut remains ours. Outside Find it opens Find scoped to
   This node and prefilled with the active query; inside Find it switches the
   scope. Phones reach the same place from More's **Search this view**. The
   header funnel, the Cmd+K "Filter this view" command, and the filter input's
   Escape ladder are removed.
6. **Query suggestions follow the token, not the box.** Any `key:` token (such
   as `is:`, `has:`, `highlight:`) and `#` show their registered values or the
   tag corpus at the top of Find's list, and selecting one inserts text. A bare
   word suggests nothing, so nodes and commands stay on top; the operator cheat
   sheet on an empty box is not carried over. A token that is already a
   complete suggestion, such as a reopened filter's `#work`, suggests nothing,
   so Enter still opens the first result. Undo and redo in the box edit the
   query, never the outline (as the filter input did).
7. **Saved queries live in Find.** The pill's pin saves and unsaves (0048 #3).
   Find lists every saved query in the rail's Saved section on desktop and in
   the list on phones. A row fills Find with its query (0083 #5). The pencil
   renames inline (Enter commits, Escape or blur cancels) and the X deletes, as
   0048 #4 specified for the old popover. Desktop also lists saved queries that
   match a typed name in the list, so the keyboard can run them. Storage and
   query-only scope are unchanged.

## Trade-offs

Filtering takes one more step than live typing in a resident input: type, then
Shift+Enter. In return there is one box to learn, every search shows where the
matches are, and the outline is never altered until you ask. Removing the
funnel also removes the header's filter-state toggle; the pill now carries that
signal next to the content it affects. Saved rows carry three controls, so they
are buttons rather than list options; desktop keyboard users reach the same
queries by typing their name.

The release bump is minor, matching 3.3.0's Find and filter change: Cmd+F and
Search still find and filter, so nothing a reader relies on needs an action.

Verification covers both-place results, scope rail and tabs, Cmd+F in and out
of Find, Show in outline and the pill, `key:` suggestions, saved rename and
delete, mirrors and recovery under filters, and phone rendering in the iOS
simulator. Device emulation does not prove screen-reader behavior.
