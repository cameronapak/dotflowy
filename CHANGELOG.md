# dotflowy

## 1.2.1

### Patch Changes

- cf52c65: Drag-reorder now follows the active filter: while a `?q=` filter is on, drops target only the visible rows (landing right after the visible predecessor when the real tree has hidden siblings in between), and a drop that lands the node hidden shows a quiet toast instead of silently vanishing it.
- 651c480: Escape in the filter input reliably clears the text on the second press again — a deferred popover reveal from the summon animation no longer re-opens a popover you already closed.
- 37d1554: Keyboard navigation now works while a filter is active: Arrow Up/Down (and delete/selection focus landing) walk exactly the rows the filter shows, instead of silently getting stuck on rows the filter hid.
- 11aa087: Disable pinch-zoom on mobile.

## 1.2.0

### Minor Changes

- 1cd17ff: The header filter magnifier is now a toggle: press to open the filter, press again to clear the query and collapse the row. It lights up solid while a filter is active, so it reads as an on/off control. Filter autocomplete suggestions now ease in after the subheader finishes expanding instead of flashing at a stale position, and respect reduced-motion settings.
- 718f269: Forgot your password? You can now reset it from the sign-in screen — a reset link lands in your inbox and expires after an hour.
- 28e18c9: Dotflowy now installs to your home screen with a proper app icon (iOS and Android), and links to the app show a rich preview card when shared.

### Patch Changes

- 46aa0e4: When something goes wrong, the app now shows a recover screen instead of a blank page, and errors are reported to us (with your note text scrubbed out) so we can fix them faster.
- 008cc9a: Error reports now strip the query string from URLs and navigation breadcrumbs, so an active outline filter (`?q=`) or a pasted link can't ride an error report — closing a gap in the note-text scrub.

## 1.1.0

### Minor Changes

- e806f5a: Sign in with Google. Existing accounts connect Google from the More menu ("Connect Google") and can then use either sign-in method; signup stays invite-only, including through Google.

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
