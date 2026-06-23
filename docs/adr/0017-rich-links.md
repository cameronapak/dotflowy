# ADR 0017: Rich links (markdown links that fold per bullet)

Status: accepted (2026-06-23), **implemented**, then **revised** — the reveal granularity moved
from **per-bullet** to **per-link** (Obsidian Live Preview style) on 2026-06-23. The original
per-bullet design and rationale below are kept for the record; **the binding behavior is the
Addendum: per-link reveal** at the bottom, which supersedes the per-bullet reveal sections.
Designed in a grilling session; one build detail was refined (search folds links to **label
only**, see *Search corpus*).

Relates to:

- [ADR 0015](./0015-tag-filtering.md) and `inline-code.ts` — same "raw markdown is the source
  of truth, decorate to HTML live" mechanism. **Links are the first construct that *folds*:**
  the rendered form is *shorter* than its source (`Anthropic` vs `[Anthropic](https://…)`),
  which breaks the source-length-equals-display-length invariant that code and tags rely on.
  This ADR is mostly about confining the damage from that one fact.
- [ADR 0008](./0008-column-preserving-caret-nav.md) — reuses `caretPositionFromPoint`; the
  focus-time caret remap (below) is a cousin of column-preserving nav.
- [ADR 0014](./0014-localized-node-rendering-via-tree-store.md) — decoration stays per-bullet;
  no index/`node` props reintroduced.

## Glossary

- **Link** — an inline token in a node's text of the form `[label](url)`, living literally in
  `node.text`. **Not a stored field** — exactly like a `` `code` `` run or a `#tag`. Delete the
  node and the link goes with it; no schema field, no migration.
- **Folded** — a link's clean rendered form: `<a href="url">label</a>`, the URL hidden. What you
  see when the bullet is **not** focused.
- **Revealed** — a link's raw editable form: the literal `[label](url)` shown as plain text. What
  you see when the bullet **is** focused. Editing a link means editing this.
- **Per-bullet reveal** — the reveal granularity: focusing a bullet reveals **every** link in it
  at once; blurring folds them all. Not per-link (Obsidian-style). See *Why per-bullet*.
- **The fold seam** — the deliberate inconsistency that links **fold** while `` `code` `` and
  `#tags` **never** do. Code/tags can stay raw-visible because their source length equals their
  rendered length; links can't. Accepted (see *Why*).
- **Source offset** — a caret position measured as a character index into `node.text` (the raw
  markdown). Every existing caret consumer (Enter-split, Backspace, arrow nav) already speaks
  this. Because a focused bullet is always **revealed** (raw), the caret only ever sits in raw
  text, so source offset stays the only offset the editor needs — **no source↔display mapping on
  the hot path.**

## Decision

A link is stored as literal `[label](url)` markdown in `node.text` (no schema change). It renders
**folded** (a clean `<a>`) when its bullet is blurred and **revealed** (raw `[label](url)`) when
its bullet is focused. Reveal is **per-bullet**. Editing a link is editing its raw markdown
inline — there is **no toolbar** and no link dialog. A folded link **opens** on click/tap.

### Storage: markdown in the string, no schema change

`node.text` keeps being a plain string; a link is just `[label](url)` inside it. This is the third
tenant of the `inline-code.ts` mechanism (after code runs and `#tags`): raw markdown is the source
of truth, the contentEditable holds decorated HTML rebuilt live. No `nodeSchema` field, no
`collection.ts` migration, links delete with the node. ADR 0005 (no zod defaults) and the
"text is a plain string" assumption that `decorate`, `parseTags`, Fuse, and the Enter-split slice
all depend on stay intact.

### Why per-bullet reveal (this is the whole trick)

The naive approach — render every link folded always, even while editing — forces a
**source↔display offset map on every keystroke**, because the caret would sit in text whose
rendered length differs from its source length. That map would have to thread through
`getCaretOffset`, the Enter-split slice, Backspace, and arrow nav. Expensive and fragile.

Per-bullet reveal deletes that problem. **A focused bullet is always shown raw.** So while you are
editing, a link *is* its literal `[label](url)` text — source length equals display length, the
existing invariant holds untouched, and `el.textContent` in `onInput` still returns the full raw
source (no inverse "read the source back out of the DOM" function needed). Folded rendering only
ever happens on a bullet with **no caret in it**, where offsets are irrelevant.

The cost: focus a bullet to edit the *end* of a sentence and a link in its *middle* also reveals
its raw form, even though you're nowhere near it. On short bullets it's invisible; on a long
multi-link bullet it's mildly noisy. Accepted for v1 — try it, see how it feels. Per-link reveal
(Obsidian-exact, only the touched link unfolds) is a later refinement, not a rewrite, but it
*reintroduces* mixed raw/folded on one focused line and with it a slice of the offset map. Rejected
for v1.

### The fold seam: links fold, code and tags don't

Dotflowy now has two classes of inline markup:

- **Always raw-visible**: `` `code` `` and `#tags` — the backticks and the `#` are always on
  screen, focused or not, because their rendered text is the same length as their source.
- **Folds when blurred**: `[links]` — raw while focused, clean `<a>` while blurred.

This inconsistency is deliberate and accepted. Links are the only construct where the raw form is
genuinely ugly enough to want hidden; forcing them to stay raw (to match code/tags) would defeat
the entire feature.

### Creating links — four paths, no toolbar

1. **Type the markdown.** Type `[Anthropic](https://…)` by hand; blur folds it. Free, because
   storage *is* markdown. The "true to markdown" path.
2. **Paste a URL over a selection → wrap.** Select `Anthropic`, paste an http(s) URL → the
   selection becomes `[Anthropic](url)`. Matches Slack/Notion/Workflowy muscle memory.
3. **Paste a rich link with nothing selected → `[linkText](href)`.** Defined **narrowly**: the
   clipboard's `text/html` is essentially a **single `<a>`**. Anything richer (a paragraph,
   multiple elements, a table) falls back to **plain text, formatting stripped**. No partial
   rich-HTML parsing in v1.
4. **Paste a bare URL with nothing selected → auto-link.** `https://anthropic.com` becomes
   `[https://anthropic.com](https://anthropic.com)`, folding to a clickable link that shows the
   URL. Pasting a URL almost always means you want a link.

A **URL**, for paths 2 and 4, is `http://` or `https://` only. No `mailto:`, `ftp:`, or bare
`www.` in v1 — keeps detection a one-liner and avoids false positives.

### Editing links — inline raw, "edit from the edges"

There is no toolbar, so editing a link is editing its raw markdown. Get the caret into the bullet
(arrow in from a neighbor, or click an edge), which **reveals** the raw `[label](url)`; change the
URL, retype the label, or delete the whole token. Blur re-folds. Removing a link is deleting its
markdown — nothing special.

This is the **same constraint tags and code chips already carry** (ADR 0015's accepted rough edge:
"you can't click into the middle of a chip; edit from the edges"). It is consistent with the app
you already have, and it is maximally markdown-native.

### A folded link opens on click; the caret lands sanely on reveal

- **Folded link, clicked/tapped** → open the `url` in a new tab (`rel="noopener"`); suppress the
  focus/caret (delegated handler, the same pattern as the tag-chip click in `OutlineEditor`).
  Because the link is only folded while the bullet is blurred, "click opens" and "click to edit"
  never contend: to edit you click *beside* the link (or arrow in), which focuses → reveals raw.
- **Bullet focuses (folded → revealed)** → the text grows under the cursor, invalidating any
  click-placed caret. A **focus-time display→source offset map** (computed once, not per
  keystroke) lands the caret:
  - click on plain text *before* any link → exact;
  - click *on or after* a folded link → snap to just after that link's raw `)`, ready to edit.

  Deterministic, and built from pieces the app already has (`getCaretOffset`,
  `caretPositionFromPoint`).

### Escaping — simple parser + encode-on-insert

Real URLs carry parens (`…/wiki/Foo_(bar)`), which a naive `(url)` match chokes on.

- The parser regex stays trivial: label = `[^\]]*`, url = `[^)]*`.
- Whenever **we** insert a link (paste-wrap, rich-paste, auto-link), the URL is **percent-encoded**
  for the characters that would break the parser — `(`→`%28`, `)`→`%29`, space→`%20`. Servers
  resolve those fine, and the **label keeps its pretty parens** (only the `(url)` half is encoded).
- Accepted rough edge: a *hand-typed* URL with a literal `)`, or a label containing a literal `]`,
  breaks the fold. Rare; the common (machine-inserted) paths always produce a safe URL. Full
  CommonMark balanced-paren parsing was rejected as more code for a case encode-on-insert already
  covers.

### Search corpus is the stripped projection

Fuse (the Cmd+K switcher, ADR 0012) indexed raw `node.text`, which now carries `[label](url)`
noise. It now indexes a **stripped projection** instead: each link flattens to its **label**
(`stripLinks` in `links.ts`), and the result rows display that same stripped text.

**Refined from the original design:** the ADR first proposed flattening to `label url` so a link
was findable by its domain too. But Fuse's match indices point into the *searched* string, and
the row highlights the *displayed* string — if those differ, the `<mark>` ranges land on the
wrong characters. Folding to label-only keeps search string == display string, so highlights stay
correct and result rows never show a raw URL. Finding a link by its **domain** is the cost;
**deferred** (it needs a decoupled search-vs-display path).

### Edge cases / invariants

| Situation | Behavior |
| --------- | -------- |
| What is a link | A complete `[label](url)` token. An incomplete one (mid-typing `[foo](`) is plain text until closed — so typing one is never fought. |
| What is a URL (auto-detect) | `http://` / `https://` only. Others are plain text in v1. |
| Token precedence | **Link → code → tag**, one pass. A link's interior is opaque: `[see #foo](url)` does **not** also render a tag chip; the whole token is the link. |
| Focused bullet | All its links **revealed** (raw). Source offset == display offset; all existing caret logic unchanged. |
| Blurred bullet | All its links **folded** (`<a>`). No caret present. |
| Click a folded link | Opens `url` in a new tab; does not place a caret. |
| Edit a link | Caret into the bullet (arrow/click edge) reveals raw; edit the markdown; blur re-folds. |
| Whole-bullet bare-URL link | Edited from its start edge or by arrowing in (clicking its body opens it). Accepted. |
| Caret landing on reveal | Focus-time display→source map; click-after-a-link snaps to just past its raw `)`. |
| URL with parens / spaces | Percent-encoded on insert (`%28 %29 %20`); label keeps pretty parens. |
| Hand-typed URL with literal `)` / label with `]` | Breaks the fold. Rare, accepted. |
| Zoomed title | Same as a bullet — links fold when the title isn't focused, reveal when it is (same `decorate()` path). |
| Touch | Tap a folded link → opens it (focus/caret suppressed); editing rides native mobile text selection + raw reveal. |
| Multi-line / structured paste | Falls back to plain text. No tree-from-paste in v1. |
| Undo | One step per insert (the existing `capture` discipline); folded↔revealed is a render concern, never an undo entry. |

## Why

- **Parsed, not stored** — zero schema change, no `collection.ts` migration, links delete with the
  node. The exact argument ADR 0015 made for tags; links are the next tenant of `inline-code.ts`.
- **Per-bullet reveal over an offset map** — the cheapest way to get clean rendering *and* keep the
  single-offset-space invariant the whole editor is built on. The hard part of "rich links" is the
  source≠display length gap; per-bullet reveal confines that gap to bullets with no caret, where it
  costs nothing.
- **No toolbar** — a selection toolbar is an *authoring* affordance; it does not answer storage,
  rendering, or reveal, and its natural next buttons (bold/italic) are the on-ramp to a
  document-model editor (see *Rejected*). Inline raw editing is markdown-native and reuses the
  chip-editing constraint users already meet with tags/code.
- **Click opens** — a folded link reads as a link; opening is the least surprising click action.
  Editing-from-the-edges is already the app's chip-editing model, so nothing new is imposed.
- **One decoration site** — bullets and the zoomed title both call `decorate()`, so links light up
  in both from a single change to `inlineMarkupHtml()`.

## Rejected alternatives

- **Atomic link chips with a full source↔display offset map.** Render links folded always, treat
  each as one caret-atomic unit, and map display offsets to source offsets on every keystroke.
  Works, but threads a mapping layer through `getCaretOffset`, Enter-split, Backspace, and arrow
  nav, plus needs an inverse `readSource(el)` (because a folded chip's `textContent` is the label,
  not the source). Per-bullet reveal gets the same clean look with none of that. **Rejected.**
- **Per-link reveal (Obsidian-exact).** Only the link the caret touches unfolds; others on the
  line stay folded. Prettier, but mixed raw/folded on one focused line reintroduces the offset map
  and a "which link is active" recompute on every caret move. **Deferred** — a refinement on top of
  per-bullet, not a rewrite.
- **Always-visible raw links (like backticks).** Free (links would behave exactly like code), but
  it defeats the feature — the whole point is a clean `Anthropic`, not `[Anthropic](https://…)` on
  screen forever. **Rejected.**
- **Selection toolbar / floating popover for bold/italic/link.** Considered seriously. It *is* a
  nicer authoring + link-editing affordance (it would have dissolved the caret-landing edge by
  editing the URL in a field). But it solves none of the storage/render decisions, and its obvious
  growth (bold/italic) leads straight to the next item. Cut for v1; editing is markdown-native
  instead.
- **Rich-text document model (Lexical / ProseMirror).** The right tool *if* we want robust
  bold/italic/strikethrough with range **toggling** (is-this-range-already-bold, partial overlaps,
  nesting) — operations a markdown string is bad at. That's a substrate rewrite of the manual
  contentEditable + `decorate()` approach (and ADR 0014's localized rendering). **Out of scope for
  v1.** Revisit only when range-toggle formatting is actually wanted; that re-evaluation is its own
  ADR, not a quiet expansion of this one.
- **Storing links as a `marks`/spans field.** A parallel structured field instead of inline
  markdown. Adds a schema field, a migration, and a perpetual text↔marks sync problem, and breaks
  the "text is a plain string" assumption across `decorate`, `parseTags`, Fuse, and Enter-split.
  **Rejected** for the same reasons ADR 0015 rejected a `tags: string[]` field.
- **Full CommonMark balanced-paren URL parsing.** Handles hand-typed URLs with literal parens, but
  it's more code for a case `encode-on-insert` already covers for every machine-inserted link.
  **Rejected** for the simpler parser.

## Deferred (designed-in, cut from v1)

- **Bold / italic / strikethrough** — and with them the document-model-editor decision above.
- **A selection toolbar / popover** — additive later; the action logic would be identical, so it's
  not a one-way door.
- **Per-link reveal** — refinement over per-bullet.
- **Non-http(s) URL schemes** (`mailto:`, `www.` autolink) and **structured paste** (multi-line
  text or HTML becoming a subtree).

## Known rough edges

- **Edit a link from its edges, not its middle.** Clicking a folded link opens it, so editing means
  clicking beside it (or arrowing in) to reveal the raw markdown. Same constraint as tag/code chips
  (ADR 0015), now extended to links. A bare-URL bullet that's *entirely* one link is edited from its
  start edge.
- **Caret can drift when you click *after* a folded link** — the link expands to raw on focus, so
  the landing snaps to just past its `)` rather than the exact pixel clicked. Deterministic, but not
  pixel-perfect.
- **Hand-typed URL with a literal `)` (or a label with `]`) breaks the fold.** Mitigated by
  encode-on-insert for paste/auto-link; only bites manual typing of awkward URLs.
- **Long multi-link bullet reveals all its links at once** (per-bullet reveal). Accepted; revisit
  with per-link reveal if it grates.
- **No test runner** (AGENTS.md); `typecheck` is the only static gate. Walk by hand: type
  `[x](https://example.com)` in a bullet → blur folds it to a clean `x`; click `x` → opens in a new
  tab; click beside it → reveals raw, edit the URL, blur re-folds; paste a URL over a selection →
  wraps; paste a bare URL → auto-links; paste a copied webpage link → `[title](url)`; paste a URL
  with parens → URL percent-encoded, label keeps parens; Cmd+K search finds the link by its words
  and by its domain; same behavior in the zoomed title.

## What changed (as built)

- **`src/data/links.ts`** (new) — the pure, DOM-free link layer mirroring `tags.ts`: `LINK_PATTERN`
  (composed into `inline-code.ts`'s token regex), `parseLinks`, `hasLink`, `stripLinks`,
  `isHttpUrl`, `bareHttpUrl`, `encodeUrlForMarkdown` (`( ) space` → `%28 %29 %20`), and
  `displayToSourceOffset` (the focus-time caret remap).
- **`src/components/inline-code.ts`** —
  - `inlineMarkupHtml(text, revealed)`: tokenizes **links first**, then code, then tags. When
    `revealed`, a link emits its raw text (escaped, interior not re-tokenized); when not, a clean
    `<a class="node-link" data-link href target="_blank" rel="noopener noreferrer">label</a>`.
  - `decorate(el, text, revealed, preserveCaret)`: threads `revealed` through. `getCaretOffset` /
    `setCaretOffset` **unchanged** (a focused bullet is revealed → raw → source offsets); both
    `setCaretOffset` and a new `getSelectionRange` are now exported for paste.
- **`src/components/paste-links.ts`** (new) — `pasteIntoBullet`: always `preventDefault`s and
  inserts plain text, with the three link special-cases layered on (wrap selection, rich single
  anchor, bare-URL auto-link). `singleAnchor` parses clipboard `text/html` via `DOMParser`.
- **`src/components/OutlineNode.tsx`** —
  - sync effect, `onInput`, `onCompositionEnd`, the task-autoformat branch all pass
    `revealed = document.activeElement === el`. `el.textContent` in `onInput` stays correct
    (focused = raw).
  - **new `onFocus`**: reveals (raw) and remaps the caret via `displayToSourceOffset`; **`onBlur`**
    (alongside the existing menu-close): folds. Both **early-return on a link-free bullet**
    (`hasLink`), so the 99% case is untouched and the native click caret stands.
  - **new `onPaste`**: delegates to `pasteIntoBullet`.
  - The `syncedRef` guard stays keyed on **text only** — simpler than the plan said. The focus/blur
    handlers own the fold/reveal swap (text unchanged), and the sync effect owns store-driven text
    changes; the two concerns don't collide, so no `revealed`-keyed guard is needed.
- **`src/components/OutlineEditor.tsx`** — the delegated content-container handler gains an
  `<a data-link>` case (block the caret on `mousedown`, `window.open` on `click`). `ZoomedTitle`
  gets the same `revealed` threading, `onFocus`/`onBlur` fold-reveal, and `onPaste` — it shares the
  content container, so link-open already covers it.
- **`src/components/node-switcher.tsx`** — Fuse indexes a `{ node, text: stripLinks(node.text) }`
  projection; result rows and crumbs display `stripLinks(...)` too (see *Search corpus*).
- **`src/styles.css`** — `.node-link` color (light/dark) for the folded anchor.
- **`e2e/rich-links.spec.ts`** (new) — fold/reveal on focus, click-to-open (via a stubbed
  `window.open`), and the four paste paths incl. parens encoding. Full suite (16) green.
- **No schema change, no `collection.ts` migration, no new route.** `typecheck` clean (the two
  pre-existing `form.tsx`/`vite.config.ts` errors are unrelated); production build + prerender pass.

---

## Addendum: per-link reveal (supersedes per-bullet reveal)

Status: **binding**, **implemented** (2026-06-23). Supersedes the *Why per-bullet reveal* and
per-bullet behavior above. Storage, creation paths, escaping, click-to-open, and search are
**unchanged** — only the reveal granularity and the rendering/caret internals change.

### Target behavior (mimicking Obsidian Live Preview)

A link folds/reveals based on **caret proximity to that one link**, not the whole bullet:

- **Caret not within the link** → **folded**: the label only, in link color, with a trailing
  **external-link icon** (lucide `external-link`). The `[..](..)` markdown is hidden.
- **Caret within or adjacent to the link** (source offset ∈ `[start, end]`, boundaries inclusive so
  you can arrow/click in to edit) → **revealed**: the raw `[label](url)`, **decorated**:
  - `[` `]` `(` `)` → **faint** (the most-dimmed; `.md-punct`)
  - label → normal content color (`.link-label`)
  - url → **link color** (`.link-url`)
  - external-link icon still shown after `)`
- **At most one link is revealed** — the one the caret is in. Every other link on the same focused
  line stays folded. (This is the case the per-bullet design avoided by revealing the whole bullet.)

### Why this is more work than per-bullet (and where the cost lives)

Per-bullet's whole trick was "focused ⇒ every link raw ⇒ `el.textContent` *is* the source and the
caret math is untouched." Per-link breaks that: a **focused** bullet can hold **folded** links, so:

1. **A revealed link stays 1:1.** It is rendered as colored spans whose combined `textContent`
   equals its source (`[label](url)`), exactly like code/tag chips — no mapping for the active link.
2. **A folded link is an atomic widget.** `<a data-link contenteditable="false" data-src="[..](..)"
   data-src-len="N">label</a>`. The caret can sit *before* or *after* it, never inside (entering its
   boundary is what reveals it).
3. **`el.textContent` is no longer the source** (folded links drop their url), so a new
   **`readSource(el)`** reconstructs the markdown: walk the DOM, emit `data-src` for folded links and
   `textContent` for everything else (revealed-link spans / code / tags are 1:1). Used by `onInput`,
   `onCompositionEnd`, and paste instead of `el.textContent`.
4. **`getCaretOffset` / `setCaretOffset` return/consume SOURCE offsets**, correcting for folded
   widgets: `getCaretOffset` adds `(data-src-len − label.length)` for each folded link before the
   caret; `setCaretOffset` consumes `data-src-len` per folded link and snaps to *after* it if a
   source offset lands "inside" the atomic token. Plain text, the active revealed link, code, and
   tags are all 1:1, so they need no correction. (`displayToSourceOffset` from the first cut is
   subsumed by this and removed.)

### Rendering + reflow

- `inlineMarkupHtml(text, revealOffset: number | null)`: a link reveals iff `revealOffset != null`
  and `revealOffset ∈ [start, end]`; else it folds. `revealOffset` is the caret's **source** offset
  (null when the bullet is blurred → all fold). `decorate` stamps `el.dataset.source = text` so any
  handler can recover the canonical source.
- **`selectionchange` listener, live only while a bullet is focused** (registered on focus, removed
  on blur). On each caret move it computes the source offset (`getCaretOffset`), finds the link now
  under the caret, and — **only if the active link changed** — re-decorates with the new
  `revealOffset` and restores the caret (avoids rebuild thrash and caret jitter). Blur → decorate
  with `null` → everything folds.

### Coloring (from the reference screenshot)

`--muted-foreground`-or-fainter for `.md-punct`; the existing `.node-link` blue for `.link-url` and
the folded label; normal `--foreground` for the revealed `.link-label`. External-link icon via a CSS
`::after` mask (inline lucide `external-link` SVG, `background-color: currentColor`) on both the
folded `<a>` and the revealed wrapper.

### Edge cases

| Situation | Behavior |
| --------- | -------- |
| Caret at a link's exact start/end boundary | Reveals (adjacency), so you can edit from either edge. |
| Selection overlapping a folded link | Reveal it (any overlap counts as "on" the link). |
| Typing that completes/breaks a token | `onInput` recomputes via `readSource` + reflow. |
| Two links on one line, caret in the first | First revealed, second stays folded. |
| Blurred bullet | `revealOffset = null` → all links folded (unchanged from per-bullet on blur). |

### Risk

This rewrites the exact caret functions the per-bullet design protected, so regression risk is
higher. The e2e safety net (`enter-split`, `keyboard-nav`, `rich-links`) must stay green, plus new
`rich-links` cases: a multi-link line revealing only the caret's link, and reveal-on-arrow-cross.

### As built (deviations from the plan above)

- **`el.dataset.source` stamping was dropped** in favor of `readSource(el)` everywhere a handler
  needs the canonical source. `readSource` is the live truth (a stamped attribute would be stale
  mid-keystroke, before `decorate` re-runs); keeping one mechanism is simpler and avoids a per-
  keystroke attribute write.
- **The rebuild guard is a module-level `WeakMap<HTMLElement, string>`**, not `el.innerHTML === html`.
  The browser re-serializes boolean attrs (`data-link` → `data-link=""`) and minimally re-escapes
  attribute values, so a folded `<a>`'s serialized HTML never equals our generated string and the
  string-compare guard would rebuild on every caret move (jitter). Comparing against our own last-
  generated string makes the selectionchange reflow a true no-op when the active link is unchanged.
- **A folded link is `contenteditable="false"`** (atomic widget) so the caret can't land inside it
  and typing can't corrupt a folded url; entering its boundary is what reveals it.
- **The slash/tag menus were made source-aware too** (`readSource` + source offsets +
  `decorate`/`setCaretOffset` instead of overwriting `el.textContent`). Per-link reintroduced
  folded links on a *focused* line, so the menus' old `el.textContent = newText` would have
  flattened a folded link to its label and dropped its url. This was outside the addendum's
  "bounded to inline-code.ts + OutlineNode/ZoomedTitle" scope but is a correctness fix (silent
  data loss), so it shipped with the feature.
- **`watchCaretReveal` fast-path** bails when `readSource(el)` has no `](`, so link-free lines
  cost a `readSource` + substring check per caret move and nothing more.
- `displayToSourceOffset` (the per-bullet focus-time remap) and `slash-menu`'s now-unused
  `placeCaretAtOffset` were **removed**.
