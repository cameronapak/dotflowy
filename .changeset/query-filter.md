---
"dotflowy": minor
---

Filter your outline with a query language. Press **Cmd+F** (or run "Filter this view" from Cmd+K, or tap the active-filter bar) to open a filter box in the subheader, then type: free text (a case-insensitive substring of what you see), `"quoted phrases"`, `#tag`, `-` to negate any term, and uppercase `OR` between two terms. It also understands `key:value` operators — `is:todo`, `is:bullet`, `is:paragraph`, `is:mirror`, `is:complete`, `is:agent`, `has:link`, and `highlight:` (bare, or by color like `highlight:red`).

Filtering is live as you type, and an autocomplete popover suggests operators, their values (with color swatches for highlights), and your existing tags — so nothing is hidden grammar you have to memorize. Blur or press Enter to collapse the query into removable pills. A match now reveals its own subtree (collapse is respected, and filtering never changes what's collapsed). Escape steps back one layer at a time: close the suggestions, then the input, then the filter. The `?q=` filter is shareable and scoped to whatever you've zoomed into.
