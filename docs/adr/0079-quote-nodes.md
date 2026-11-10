---
status: accepted
---

# Quote nodes: derived from `> `, with a bar for a dot

Amended by [ADR 0080](./0080-numbered-nodes.md): numbered Kind retains its
number handle instead of the bar, while keeping quote marker editing rules.

Cam decided on 2026-11-09, after reviewing four prototyped treatments: a quote
is derived from its text, the bar replaces the dot, and Enter follows
WorkFlowy.

A node whose text source starts with `> ` (the space is required) is a
**quote**. Quote-ness is a presentation of the text, like emphasis
([ADR 0025](./0025-inline-emphasis.md)), not a Kind and not a field. The marker
is what is stored, copied, exported, searched, and written by agents.

## Derived, not a Kind

A Kind is a stored field. Paragraph ([ADR 0045](./0045-paragraph-node-kind.md))
and Embed each widened the wire schema, the Durable Object's row mapping, MCP
tools, OPML, search, mutation exclusivity, and fixtures. Deriving quote-ness
from the text needs none of that:

- **No migration.** Every node that already starts with `> ` renders as a quote
  on the next load, with no write. The repository has no client-side data
  migration, so a Kind would have left those nodes literal.
- **No wire, DO, MCP, OPML, or CLI change.** An agent that writes `> x` makes a
  quote. A stale tab never meets an unknown `kind` value.
- **Markdown stays the interchange format** ([ADR 0044](./0044-markdown-paste.md)).
  Copy as Markdown already emitted `- > x`, which CommonMark renders as a
  quote inside a list item.

Accepted costs:

- **Quote-ness is not exclusive with Kind.** A task whose text starts with `> `
  shows its checkbox and a bar where the dot would be. A paragraph-kind node
  that starts with `> ` shows the bar, not the paragraph glyph: the bar
  outranks the paragraph glyph. A quoted task exports as `- [ ] > x`, which
  round-trips in Dotflowy, but GitHub and CommonMark show `> x` as text inside
  the task: Markdown cannot open a block quote after a task checkbox.
- **Tests read text.** `isQuoteText` (`src/data/quote.ts`) is the one test; the
  glyph, the editor rules, `is:quote`, and Markdown import all call it.

## The bar is the dot

The bar replaces the dot in the bullet column. It is the same
`<button aria-label="Zoom in">` every Kind has, so it zooms on click or tap
and starts a drag, and `Mod+.` still zooms from the text. It stretches to the
quote's own lines, not its children: children are commentary or sources, not
part of the quotation. The collapsed state still shows on the zoom target.

- **Desktop:** a 3px bar in a 16px column, muted, and `primary` on hover.
  Wherever the ring shows (hover, or collapsed with hidden children), the bar
  pulls in 5px from each end, so the ring pads it vertically too. The button,
  and so the hit area, keeps its size.
- **Coarse pointers:** the column keeps its 24px width
  ([ADR 0029](./0029-reading-size-and-touch-targets.md)) and the full height
  of the quote, so the tap target grows with the quote.
- **Zoomed title:** the title shows a bar of its own in the glyph slot, which
  is not a zoom target, like the paragraph glyph.
- **Quick-add:** an inset bar on the text once text follows the marker.
- **Accessible name:** the row's textbox label drops the marker, so a screen
  reader does not read "greater than".

Rejected treatments, from the prototype: keeping the dot with a bar in the text
column (WorkFlowy's look; weaker signal), a quote glyph in the dot's place
(long quotes read like paragraphs), and a dot with a hairline tail (a stub on
one-line quotes). A tinted card fights row hover and selection fill.

## Editing

- **Creation.** Typing `> ` at the start of a row makes it a quote; the text is
  the state, so there is no autoformat write. `>5` and `->` stay literal.
  `/quote` adds or removes the marker and keeps the caret on the same
  character.
- **The marker folds.** The `quote` plugin registers a folding token
  (precedence 45). It hides while the caret is away and reveals as dimmed
  punctuation at offsets 0 to 2. An empty quote, `> ` alone, does not fold:
  Chrome cannot hold a caret after a trailing non-editable atom, so typing into
  a freshly carried quote would land in front of the marker.
- **Enter carries the marker.** Enter at the end of a quote, a mid-text split,
  and the new row above (Enter at the start) all begin with `> `. A split never
  cuts the marker; a caret inside it splits after it.
- **Enter on an empty quote unquotes it in place** instead of adding a row, the
  way Enter on an empty list item ends a list. It is an in-place text edit in
  the row keymap, not a structural write, so keys typed right after it land in
  the same row.
- **Backspace at offsets 0 to 2 removes the whole marker**, on all three render
  surfaces (`quote-marker.ts`). One Backspace turns a carried quote back into a
  bullet. At offset 0 this runs ahead of the row's own Backspace rules (marker
  reveal, [ADR 0045](./0045-paragraph-node-kind.md), and the join,
  [ADR 0059](./0059-backspace-joins-into-the-previous-row.md)): the first
  Backspace removes the whole `> `, and the next one follows the row's usual
  rule. Unlike the list and task markers, the quote marker goes in one press,
  because it is text, not a Kind.

## Paste and export

This amends ADR 0044's blockquote row. A blockquote line keeps one `> ` on a
**bullet**, never a paragraph: a paragraph whose text starts with `> ` exports
with the `- ` fallback and would not come back a paragraph. A run of `>` (`>>`)
collapses to one marker. A list marker or checkbox inside the quote still
applies, so `> - [ ] x` is a task with the text `> x`. A line of only `>` is a
blank separator. Export is unchanged: `- > x` re-parses to the same quote.

`flattenInline` strips the marker, so plain-text surfaces such as breadcrumbs
and titles read the quotation without `> `.

## Search

`is:quote` (Seam K) is a text test, so the app filter and MCP search share it
through the Worker's operator composition.

## Research

Verified from primary sources on 2026-11-09:

- WorkFlowy supports quotes with `> `, `/quote`, and `is:quote`; Enter twice
  leaves a quote, and the dot stays: [Quote blocks](https://workflowy.com/help/quote-blocks/),
  [launch post](https://blog.workflowy.com/code-blocks-inline-code-quotes-strikethrough/).
- Notion makes a quote with `"` and a space; `> ` makes a toggle:
  [Writing and editing basics](https://www.notion.com/help/writing-and-editing-basics).
- Obsidian uses `>` for quotes and callouts:
  [Basic formatting syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Editing%20and%20formatting/Basic%20formatting%20syntax.md).
- CommonMark starts a block quote with `>`, with or without the space:
  [CommonMark 0.31.2, 5.1](https://spec.commonmark.org/0.31.2/#block-quotes).
  Dotflowy requires the space so `>5` stays text.
