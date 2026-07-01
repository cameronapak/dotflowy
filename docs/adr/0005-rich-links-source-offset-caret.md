# Rich links: the source-offset caret and the bracket reveal

Markdown `[label](url)` is parsed from `node.text` (no schema field) and is the one construct that
**folds** — it renders as a clean `<a contenteditable="false" data-src="[label](url)">` unless the
caret is within/adjacent to it. Reveal is **per-link**: at most one unfolds at a time.

**The reveal is BRACKET-style — the URL never expands into the line.** A caret-adjacent link shows
`[label]` as editable text (the brackets appear, Lettera/Obsidian-style) plus a small `(✎)` chip
standing in for the whole `(url)` half — itself an atom (`data-src="(url)"`,
`contenteditable="false"`). Editing the URL happens in the **Edit Link popover** (two fields, text +
url, no preview embed — rejected by design), opened from the pencil trailing a folded `<a>` or the
revealed chip; the write-back is verbatim-match-or-drop (`replaceLinkToken`), like the unfurl label
swap. Rationale: a raw URL is long and unreadable; expanding it mid-line shoves the rest of the text
around for an edit you almost never do inline. (Supersedes the original full-raw reveal.)

**Why it's not in the code, and the landmine:** because a *focused* bullet can hold *folded* links,
`el.textContent` is **no longer the source** — the folded `<a>` shows `label`, and even the revealed
link keeps its `(url)` half folded. So:
- **`readSource(el)`** (`inline-code.ts`) reconstructs the markdown (`data-src` for atoms,
  `textContent` otherwise). It must replace `el.textContent` in `onInput`, paste, **and the
  slash/tag menus** — a `/cmd` or `#tag` on a folded-link line would otherwise flatten the url
  (silent data loss).
- **`getCaretOffset`/`setCaretOffset` speak SOURCE offsets**, adding `(data-src-len − label.length)`
  per folded atom before the caret.
- **Copy/cut go through the same source read** (`copySourceSelection`/`cutSourceSelection`,
  `paste.ts`): the native clipboard would carry the rendered label and silently drop the url half,
  so the handlers write the source slice — whatever you copy comes back as markdown.

All of it fast-paths out on lines with no `](`, which is 99% of them.

**Don't:** assume `textContent` is the source anywhere a line can hold a link; expand the raw URL
inline on reveal (the popover is the URL editor); revert to per-bullet reveal (noisy on multi-link
lines); thread a full source↔display offset map (the revealed `[label]` stays 1:1 and atoms carry
their own lengths — strictly less mapping); or capture text for a deferred repaint
(`revealLinkAtCaret` re-reads the DOM at frame time — a snapshot races a synchronous cut/paste
landing between focus and frame).
