# ADR 0017: Rich links (markdown links that fold per link)

Status: accepted (2026-06-23), **implemented**. The reveal granularity is **per-link** (Obsidian
Live Preview style). An earlier cut shipped **per-bullet** reveal the same day and was replaced
within hours — kept only as a rejected alternative below, because *why not per-bullet* explains why
the caret math is the shape it is.

Relates to:

- [ADR 0015](./0015-tag-filtering.md) and `inline-code.ts` — same "raw markdown is the source of
  truth, decorate to HTML live" mechanism. **Links are the first construct that *folds*:** the
  rendered form is shorter than its source (`Anthropic` vs `[Anthropic](https://…)`), breaking the
  source-length-equals-display-length invariant code and tags rely on. This ADR is mostly about
  confining the damage from that one fact.
- [ADR 0008](./0008-column-preserving-caret-nav.md) — reuses `caretPositionFromPoint`.
- [ADR 0014](./0014-localized-node-rendering-via-tree-store.md) — decoration stays per-bullet; no
  index/`node` props reintroduced.

## Glossary

- **Link** — an inline `[label](url)` token living literally in `node.text`. **Not a stored field**
  (like a `` `code` `` run or `#tag`): no schema field, no migration; delete the node and it goes.
- **Folded** — a link's clean rendered form (`<a>label</a>`, url hidden). What you see when the
  caret is not in it.
- **Revealed** — a link's raw editable form (`[label](url)` shown decorated). What you see and edit
  when the caret is within or adjacent to it.
- **Per-link reveal** — folding granularity: only the one link the caret is in reveals; every other
  link on the same line stays folded. At most one revealed at a time.
- **Source offset** — a caret position as a character index into `node.text` (the raw markdown).
  Every caret consumer (Enter-split, Backspace, arrow nav, the menus) speaks this.

## Decision

A link is literal `[label](url)` markdown in `node.text` (no schema change). It renders **folded**
(a clean `<a>`, label only, link color, trailing external-link icon) unless the caret is within or
adjacent to it (source offset ∈ `[start, end]`, boundaries inclusive so you can arrow/click in),
in which case it **reveals** decorated raw: faint `[]()` punctuation (`.md-punct`), normal-color
label, link-color url. Reveal is **per-link** — at most one link unfolds. Editing a link is editing
its raw markdown inline; there is **no toolbar** and no link dialog. A folded link **opens** on
click (new tab).

### Storage: markdown in the string

`node.text` stays a plain string; a link is just `[label](url)` inside it — the third tenant of the
`inline-code.ts` mechanism after code and tags. No schema field, no `collection.ts` migration. The
"text is a plain string" assumption that `decorate`, `parseTags`, Fuse, and Enter-split all depend
on stays intact.

### The fold seam: links fold, code and tags don't

Links are the only construct where the raw form is ugly enough to hide; `` `code` `` and `#tags`
stay raw-visible because their rendered length equals their source. This inconsistency is
deliberate — forcing links to stay raw would defeat the feature.

### The caret cost of per-link reveal (the heart of the design)

Because a **focused** bullet can hold **folded** links, the per-bullet shortcut ("focused ⇒ all raw
⇒ `el.textContent` *is* the source") does not hold. So:

1. **A revealed link is 1:1** — colored spans whose combined `textContent` equals its source, like
   code/tag chips. No mapping for the active link.
2. **A folded link is an atomic widget** — `<a data-link contenteditable="false" data-src="[..](..)"
   data-src-len="N">label</a>`. The caret sits before or after it, never inside (entering its
   boundary is what reveals it).
3. **`readSource(el)` reconstructs the markdown from the DOM** — `data-src` for folded links,
   `textContent` for everything else (revealed spans / code / tags are 1:1). It replaces
   `el.textContent` in `onInput`, `onCompositionEnd`, paste, **and the slash/tag menus** (a `/cmd`
   or `#tag` on a line with a folded link would otherwise flatten its url — silent data loss).
4. **`getCaretOffset` / `setCaretOffset` speak SOURCE offsets**, correcting for folded widgets:
   add `(data-src-len − label.length)` per folded link before the caret; snap to *after* a folded
   link if an offset lands "inside" it. Plain text, the active link, code, and tags need no
   correction.
5. **Reveal reflow is a `selectionchange` listener**, live only while a bullet is focused. On each
   caret move it finds the link now under the caret and — only if the active link changed —
   re-decorates with the new `revealOffset` and restores the caret. The rebuild is guarded by a
   module-level `WeakMap<HTMLElement, string>` comparing against our **own** last-generated HTML
   (the browser re-serializes boolean attrs, so an `el.innerHTML ===` guard would rebuild on every
   caret move). Blur → decorate with `revealOffset = null` → everything folds. Both fast-path bail
   on a line with no `](`, so link-free lines stay free.

### Creating links — four paths, no toolbar

1. **Type the markdown** by hand; it folds when the caret leaves it.
2. **Paste a URL over a selection → wrap** (`Anthropic` + url → `[Anthropic](url)`).
3. **Paste a single-anchor `text/html` clipboard → `[title](href)`.** Anything richer falls back to
   plain text, formatting stripped (no partial rich-HTML parsing in v1).
4. **Paste a bare http(s) URL → auto-link.**

A **URL** for paths 2/4 is `http://`/`https://` only (no `mailto:`, `ftp:`, bare `www.` in v1).
Paste lives in `paste.ts`'s `pasteIntoBullet`, which always `preventDefault`s and inserts plain
text with these three cases layered on.

### Escaping — simple parser + encode-on-insert

The parser regex stays trivial (label `[^\]]*`, url `[^)]*`). Whenever *we* insert a link, the url
is percent-encoded for the chars that would break it (`(`→`%28`, `)`→`%29`, space→`%20`); the label
keeps its pretty parens. Accepted rough edge: a hand-typed url with a literal `)` (or a label with
`]`) breaks the fold — rare, and the machine-inserted paths always produce a safe url.

### Search corpus is the stripped projection

Fuse (the Cmd+K switcher) indexes a **stripped projection** — each link flattens to its **label**
(`stripLinks`), and result rows display that same text. Folding to label-only (not `label url`)
keeps search-string == display-string, so highlight `<mark>` ranges land correctly. Finding a link
by its domain is the cost; deferred (needs a decoupled search-vs-display path).

## Why

- **Parsed, not stored** — zero schema change, no migration, links delete with the node. The exact
  argument ADR 0015 made for tags; links are the next tenant of `inline-code.ts`.
- **Per-link reveal over per-bullet** — per-bullet was cheaper (the caret never sat near a folded
  link) but revealed every link on a focused line at once, which grated on multi-link bullets.
  Per-link matches Obsidian and is worth the source-offset caret math, now that `readSource` +
  source-offset correction exist.
- **No toolbar** — a selection toolbar answers none of storage/render/reveal, and its natural next
  buttons (bold/italic) are the on-ramp to a document-model editor (see *Rejected*). Inline raw
  editing is markdown-native and reuses the chip-editing constraint users already meet.
- **Click opens** — a folded link reads as a link; opening is the least surprising click. Editing is
  click-beside / arrow-in, the app's existing chip-editing model.
- **One decoration site** — bullets and the zoomed title both call `decorate()`, so links light up
  in both from one change to `inlineMarkupHtml()`.

## Rejected alternatives

- **Per-bullet reveal.** Focusing a bullet reveals *every* link in it; blurring folds them all. Its
  whole appeal was keeping the single-offset invariant — a focused bullet is always raw, so
  `el.textContent` *is* the source and the caret math is untouched (no `readSource`, no source-offset
  correction). But it reveals unrelated links on a multi-link line, which is noisy. **Shipped first,
  replaced same-day by per-link** once the caret math proved tractable.
- **Atomic link chips with a full source↔display offset map** (links folded *always*, even while
  editing). Threads a mapping layer through `getCaretOffset`, Enter-split, Backspace, and arrow nav.
  Per-link reveal keeps the active link 1:1 (raw) and only folded links atomic, which is strictly
  less mapping. **Rejected.**
- **Always-visible raw links (like backticks).** Free, but defeats the feature — the point is a
  clean `Anthropic`, not `[Anthropic](https://…)` on screen forever. **Rejected.**
- **Selection toolbar / floating popover for bold/italic/link.** A nicer authoring affordance, but
  solves none of the storage/render decisions, and its obvious growth (bold/italic) leads to the
  next item. Cut for v1; editing is markdown-native instead.
- **Rich-text document model (Lexical / ProseMirror).** The right tool *if* we want range
  **toggling** (is-this-range-bold, partial overlaps, nesting) — a substrate rewrite of the manual
  contentEditable + `decorate()` approach. **Out of scope for v1;** its own ADR if range-toggle
  formatting is ever wanted.
- **Storing links as a `marks`/spans field.** A parallel structured field: schema change, migration,
  perpetual text↔marks sync, and it breaks the "text is a plain string" assumption across `decorate`,
  `parseTags`, Fuse, and Enter-split. **Rejected**, same as ADR 0015 rejected `tags: string[]`.
- **Full CommonMark balanced-paren URL parsing.** More code for a case encode-on-insert already
  covers for every machine-inserted link. **Rejected** for the simpler parser.

## Deferred (designed-in, cut from v1)

- **Bold / italic / strikethrough** — and the document-model-editor decision above.
- **A selection toolbar / popover** — additive later; not a one-way door.
- **Non-http(s) schemes** (`mailto:`, `www.` autolink) and **structured paste** (multi-line text or
  HTML becoming a subtree).
- **Finding a link by its domain** in search — needs a decoupled search-vs-display path.

## Known rough edges

- **Edit a link from its edges, not its middle** — clicking a folded link opens it, so edit by
  clicking beside it or arrowing in. Same constraint as tag/code chips (ADR 0015).
- **Caret can drift when you click *after* a folded link** — it reveals on focus, so the landing
  snaps to just past its `)` rather than the exact pixel. Deterministic, not pixel-perfect.
- **Hand-typed url with a literal `)` (or label with `]`) breaks the fold** — mitigated by
  encode-on-insert for paste/auto-link; only bites manual typing of awkward urls.
- **No test runner** — `typecheck` is the only static gate; e2e (`enter-split`, `keyboard-nav`,
  `rich-links`) is the safety net for the caret functions this feature rewrites.
