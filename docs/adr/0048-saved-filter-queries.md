# Saved filter queries, pinned in the search popover and Cmd+K

A filter query worth typing twice is worth saving. We decided saved queries are a small synced side-collection surfaced in exactly two places — the filter input's empty-focus popover and Cmd+K — saved by a Pin toggle inside the input, and scoped to the **query only** (they run against whatever view you're in). Promoted from ADR 0047's non-goals list.

## The decisions

1. **Storage is a kv side-collection** (`saved-queries` via `/api/kv`, the tag-colors pattern): rides the per-user DO, syncs across devices, no `Node` field, no wire-schema change. Shape: `{id, name, query, createdAt}`. A saved query is user data, not a view preference — localStorage would strand it per-browser.

2. **Two surfaces, same data — the bookmark symmetry.** Bookmarks (a saved _zoom_) deliberately have no sidebar and are browsed in Cmd+K's empty state; saved queries (a saved _filter_) are their twin and follow the same shape:
   - A **"Saved" section atop the filter popover's cheat sheet** — you summoned search, so your saved searches lead. Picking one fills the input and applies it. Newest-first, top ~6.
   - **Cmd+K rows** — listed in the empty state beside Bookmarks, matchable by name while typing; running one applies the query to the current view. Full list here.
     We rejected always-visible pinned chips in the subheader (resident clutter spending a permanent row on an occasional action — the calm-over-shouting call the Spotlight indicator ADR already made) and a Workflowy-style sidebar (the standing "no sidebar" rule).

3. **Saving is a Pin toggle inside the input** — trailing, beside the clear X, visible when the query is non-empty. Click = instant save, **no naming interruption**: the name defaults to the query text. The pin renders pressed/filled when the current query is already saved; clicking again unsaves. **Pin, not star** — the star means "bookmark this zoom" in this app, and overloading it would blur the twin metaphors (star pins a _place_, pin pins a _question_).

4. **Rename and delete live on the popover's Saved rows** (hover: pencil → tiny inline name input; X → delete). Cmd+K only lists and runs. Custom names are half the value (Workflowy's "named smart views"), but they're an edit, not a gate on saving.

5. **A saved query saves the query, not the location.** It runs wherever you are — portable across zooms, like Workflowy's. "Todos under Project X" as one pinned artifact is a bookmark-plus-filter composition (the URL carries both today) or the deferred `A > B` ancestor operator — not this feature's job. Rejected storing `{query, rootId}` pairs: it couples two independent axes and duplicates what the URL already expresses.

6. **Deferred:** manual reordering (newest-first until someone misses it), sharing, and any MCP surface for saved queries.
