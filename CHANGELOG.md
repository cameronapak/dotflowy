# dotflowy

## 0.2.0

### Minor Changes

- e89548d: Paragraph nodes. A bullet can now become prose: `/paragraph` swaps its dot for a pilcrow, and the line reads as writing instead of a list item. It stays a full citizen of the outline — it takes children, collapses, zooms, and can be completed — and the pilcrow sits exactly where the dot was, so it still zooms on click and drags to reorder. Copy-as-Markdown writes a paragraph as a plain line, and pasting plain lines brings them back as paragraphs. Agents can read and write them over MCP, and they survive an OPML round-trip.
- aaf904b: A changelog. Dotflowy now ships versioned releases: a "What's new" dialog with an unread badge in the app, and a public feed on GitHub Releases. A running tab notices when the server has moved on and offers to reload.

### Patch Changes

- dc2ebba: Signing out — or signing in on a tab someone else used — now fully reloads the app, so a previous account's outline can no longer appear in, or be written into, a newly signed-in account.
