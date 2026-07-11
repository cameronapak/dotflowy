---
"dotflowy": minor
---

Summoned filter input for `?q=` (ADR 0047, slice 2): press **Cmd+F**, run the Cmd+K "Filter this view" action, or tap the active-filter bar to open a filter box in the subheader. Type the query grammar (`#tag`, `is:todo`, `has:link`, free text, `-word`, `OR`) with live, debounced filtering; blur or Enter shows the parsed terms as removable pills. Two-stage Escape: close the input, then clear the filter. The filter bar is core chrome now (not the tags plugin), so its aria-label is "Filter".
