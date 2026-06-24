# Dotflowy

A keyboard-first Workflowy-style outliner with a plugin-extended editor core. This
glossary pins the terms that are easy to confuse. It is a glossary, not a spec —
decisions and rationale live in `docs/adr/`.

## Language

**Daily note**:
A node representing one calendar day's notes. Its identity is the day it maps to
(held in the daily index), not its text — the text is a freeform, editable label
seeded to the formatted date.
_Avoid_: journal entry, diary entry, log entry

**Daily container**:
The single, auto-created, protected parent node that holds every daily note as a
child. There is exactly one per outline.
_Avoid_: journal, log, daily folder

**Daily index**:
The side-collection mapping a local date (`YYYY-MM-DD`) to a daily note's node id.
The source of truth for "which node is this day" — a sibling collection, never a
field on `Node`.
_Avoid_: date map, calendar table

**Today button**:
The header control that navigates to today's daily note, creating it (and the
container) on first use.

**Protected node**:
A node the core refuses to delete because a plugin declared it protected. The core
enforces the rule generically; the plugin owns which nodes are protected and why.
Protection is delete-only — a protected node can still be renamed and take children.
_Avoid_: locked node (implies read-only — it isn't), pinned node, system node

**Header slot**:
A node-less plugin render slot in the app header. Distinct from a **row slot**,
which decorates a single bullet and is handed that node.
_Avoid_: header widget, toolbar item

**Scripture reference**:
A Bible citation written inside `node.text` (`John 3:16`, `Genesis 1`,
`1 Cor 13:4-7`). Parsed from text by the route-bible plugin, never a stored field —
the same stance as a `#tag` or a link. A book name alone is not one (a chapter is
required); a whole-chapter reference is.
_Avoid_: verse, passage (those are the parts), citation

**Reference chip**:
The non-folding, clickable `Badge`-styled span a **Scripture reference** renders as.
Its visible text is the user's verbatim source; only the route.bible link it opens
is canonicalized.
_Avoid_: verse badge, scripture link
