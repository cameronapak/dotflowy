---
"dotflowy": minor
---

Paragraph nodes. A bullet can now become prose: `/paragraph` swaps its dot for a pilcrow, and the line reads as writing instead of a list item. It stays a full citizen of the outline — it takes children, collapses, zooms, and can be completed — and the pilcrow sits exactly where the dot was, so it still zooms on click and drags to reorder. Copy-as-Markdown writes a paragraph as a plain line, and pasting plain lines brings them back as paragraphs. Agents can read and write them over MCP, and they survive an OPML round-trip.
