# Rich links: the source-offset caret and the bracket reveal

Markdown `[label](url)` is parsed from `node.text` (no schema field) and
**folds** — it renders as an atomic wrapper containing a destination anchor and a separate pencil button unless the
caret is within/adjacent to it. Reveal is **per-link**: at most one unfolds at a time.

**The reveal is BRACKET-style — the URL never expands into the line.** A caret-adjacent link shows
`[label]` as editable text (the brackets appear, Lettera/Obsidian-style) plus a small `(✎)` chip
standing in for the whole `(url)` half — itself an atom (`data-src="(url)"`,
`contenteditable="false"`). Editing the URL happens in the **Edit Link popover** (URL, title, and
Link Title / Plain URL / Embed option tiles, without a live provider preview), opened from the pencil trailing a folded `<a>` or the
revealed chip. Write-back captures the clicked source range and the full text source,
then splices that range only if the source is unchanged. A stale draft is dropped
rather than applied to another identical link. Rationale: a raw URL is long and unreadable; expanding it mid-line shoves the rest of the text
around for an edit you almost never do inline. (Supersedes the original full-raw reveal.)

The pencil is a keyboard-accessible button, not part of the destination anchor.
The folded wrapper carries the source atom; its children do not add source characters.
The pencil follows the final word when its label wraps. The link reserves its
space on that last line so the sibling button does not wrap separately.
The favicon stays with the first text character, while the rest of the label
can wrap. The loading spinner uses the same inline group.
On touch screens, the folded pencil's 24px horizontal target expands to 44px vertically
without increasing line height or overlapping the destination label.
The revealed `(✎)` uses the icon's width without extra horizontal padding;
its touch area still expands vertically without overlapping the parentheses.
Plain URLs use the same pencil, including Embed source URLs when the
Embeds plugin is off. Focus reveals the literal URL and leaves the pencil available.
The focused plain-URL pencil carries an empty source atom so copying and caret
offsets still reflect only the URL.

Display tiles select a draft. **Done** applies the URL, title, and display together;
**Cancel** changes nothing. Only Link Title can fetch metadata, and a custom title
never triggers lookup. Embed requires a supported standalone URL on a bullet or
existing Embed, so converting an inline link cannot discard surrounding prose or
another kind. Plain URL replaces only the edited link token. Conversions preserve
child notes and edit a mirror's shared source. The initial paste chooser remains
separate; reopening the pencil uses this full editor. External-content permission
remains a separate account decision after committing Embed.

Below 768px, the editor uses the shared React Aria sheet from
[ADR 0066](./0066-narrow-screen-menu-drawers.md). Desktop keeps the anchored
popover, centered below the pencil and clamped to the viewport. Its entrance
scales from the pencil's position; reduced motion skips the animation.
Both presentations share one draft, including across width changes.
Close, Escape, an outside tap, and a swipe discard the draft like Cancel.
The sheet does not focus an input on opening; tap a field to bring up the
keyboard. Done waits for the native sheet exit before applying the draft and
opening any external-content permission dialog. Dismissal returns focus to the
link's pencil.

**Why it's not in the code, and the landmine:** because a _focused_ bullet can hold _folded_ links,
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
