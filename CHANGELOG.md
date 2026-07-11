# dotflowy

## 1.0.0

### Major Changes

- c77151c: Filter your outline with a query language, and a reworked header.

  **Relearn one gesture:** the header **magnifier now opens the filter**, not the node switcher. The switcher (Cmd+K) moves to a new **⌘ Command-center** button beside it — Cmd+K itself is unchanged.

  Press **Cmd+F** (or the header magnifier, or run "Filter this view" from Cmd+K) to open a filter box in the subheader, then type: free text (a case-insensitive substring of what you see), `"quoted phrases"`, `#tag`, `-` to negate any term, and uppercase `OR` between two terms. It also understands `key:value` operators — `is:todo`, `is:bullet`, `is:paragraph`, `is:mirror`, `is:complete`, `is:agent`, `has:link`, and `highlight:` (bare, or by color like `highlight:red`).

  Filtering is live as you type, and an autocomplete popover suggests operators, their values (with color swatches for highlights), and your existing tags — so nothing is hidden grammar you have to memorize. The filter box now stays resident showing the raw query (the old blur-into-pills behavior is gone); a trailing **X** clears it. A match reveals its own subtree (collapse is respected, and filtering never changes what's collapsed). Escape steps back one layer at a time: close the suggestions, then the text, then the box. The `?q=` filter is shareable and scoped to whatever you've zoomed into.

  **Save the filters you reuse:** click the **Pin** inside the filter box to save the current query (it syncs across your devices). Saved filters lead the filter popover — click to apply, hover to rename or delete — and appear in Cmd+K's empty state beside your bookmarks, ready to run.

### Patch Changes

- 6984fcc: Quieter "What's new" signal: the standalone header button is gone. Unread releases now show as a small notification dot on the "More" menu, and the "What's new" item is emphasized while unread.

## 0.3.0

### Minor Changes

- 19a57a1: Add a `/delete` slash command. Deleting a node was already reachable from the
  bullet keymap, Cmd+K, and the node-selection menu; this puts it in the `/`
  palette too, delegating to the same delete funnel (protection guards, the
  big-subtree confirm, atomic batch, and neighbor-focus all apply).

  The `/` palette and the `#` / `[[` caret pickers also now open on the zoomed
  page title, not just list bullets, so slash commands, tag autocomplete, and
  node-link autocomplete all work whether a node is a row or the title you've
  zoomed into.

## 0.2.0

### Minor Changes

- e89548d: Paragraph nodes. A bullet can now become prose: `/paragraph` swaps its dot for a pilcrow, and the line reads as writing instead of a list item. It stays a full citizen of the outline — it takes children, collapses, zooms, and can be completed — and the pilcrow sits exactly where the dot was, so it still zooms on click and drags to reorder. Copy-as-Markdown writes a paragraph as a plain line, and pasting plain lines brings them back as paragraphs. Agents can read and write them over MCP, and they survive an OPML round-trip.
- aaf904b: A changelog. Dotflowy now ships versioned releases: a "What's new" dialog with an unread badge in the app, and a public feed on GitHub Releases. A running tab notices when the server has moved on and offers to reload.

### Patch Changes

- dc2ebba: Signing out — or signing in on a tab someone else used — now fully reloads the app, so a previous account's outline can no longer appear in, or be written into, a newly signed-in account.
