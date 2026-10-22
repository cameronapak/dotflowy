---
"dotflowy": major
---

Filter your outline with a query language, and a reworked header.

**Relearn one gesture:** the header **magnifier now opens the filter**, not the node switcher. The switcher (Cmd+K) moves to a new **⌘ Command-center** button beside it — Cmd+K itself is unchanged.

Press **Cmd+F** (or the header magnifier, or run "Filter this view" from Cmd+K) to open a filter box in the subheader, then type: free text (a case-insensitive substring of what you see), `"quoted phrases"`, `#tag`, `-` to negate any term, and uppercase `OR` between two terms. It also understands `key:value` operators — `is:todo`, `is:bullet`, `is:paragraph`, `is:mirror`, `is:complete`, `is:agent`, `has:link`, and `highlight:` (bare, or by color like `highlight:red`).

Filtering is live as you type, and an autocomplete popover suggests operators, their values (with color swatches for highlights), and your existing tags — so nothing is hidden grammar you have to memorize. The filter box now stays resident showing the raw query (the old blur-into-pills behavior is gone); a trailing **X** clears it. A match reveals its own subtree (collapse is respected, and filtering never changes what's collapsed). Escape steps back one layer at a time: close the suggestions, then the text, then the box. The `?q=` filter is shareable and scoped to whatever you've zoomed into.

**Save the filters you reuse:** click the **Pin** inside the filter box to save the current query (it syncs across your devices). Saved filters lead the filter popover — click to apply, hover to rename or delete — and appear in Cmd+K's empty state beside your bookmarks, ready to run.
