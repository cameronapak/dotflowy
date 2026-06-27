# Rich links: the source-offset caret

Markdown `[label](url)` is parsed from `node.text` (no schema field) and is the one construct that
**folds** — it renders as a clean `<a contenteditable="false" data-src="[label](url)">` unless the
caret is within/adjacent to it. Reveal is **per-link**: at most one unfolds at a time.

**Why it's not in the code, and the landmine:** because a *focused* bullet can hold *folded* links,
`el.textContent` is **no longer the source** — the folded `<a>` shows `label`, but its source is
the full markdown. So:
- **`readSource(el)`** (`inline-code.ts`) reconstructs the markdown (`data-src` for folded atoms,
  `textContent` otherwise). It must replace `el.textContent` in `onInput`, paste, **and the
  slash/tag menus** — a `/cmd` or `#tag` on a folded-link line would otherwise flatten the url
  (silent data loss).
- **`getCaretOffset`/`setCaretOffset` speak SOURCE offsets**, adding `(data-src-len − label.length)`
  per folded link before the caret.

All of it fast-paths out on lines with no `](`, which is 99% of them.

**Don't:** assume `textContent` is the source anywhere a line can hold a link; revert to per-bullet
reveal (noisy on multi-link lines); or thread a full source↔display offset map — per-link reveal
keeps the active link 1:1, which is strictly less mapping.
