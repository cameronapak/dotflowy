# Paragraph nodes: kind as an additive field, the pilcrow as the dot

Status: accepted (2026-07-10) — design settled, implementation not started.

A **paragraph** is a third node kind alongside bullet and task: a node that reads as prose. A
pilcrow (`Pilcrow` from lucide, ¶) renders where the bullet dot would, muted, same position. Kinds
are **mutually exclusive** — a node is exactly one of bullet | task | paragraph; converting is
allowed, combining is not. A paragraph is a full tree citizen: children, collapse, indent, zoom,
and `completed` all work unchanged (completed is done-status — "mentally archived, still exists" —
deliberately independent of kind, as `schema.ts` already records for tasks).

## Storage: additive `kind`, not an `isTask` migration

`kind: NullOr(Literal("paragraph"))` — required + nullable, no default (ADR 0003), `makeNode()`
sets `null`. `null` means "bullet or task, per `isTask`". This is the exact shape `mirrorOf`,
`bookmarkedAt`, and `origin` shipped as: backfill at snapshot load (`withNodeDefaults` in
`collection.ts`) plus the `e2e/fixtures.ts` twin, wire schema in `wire-schema.ts` (both tsconfigs).

**Rejected: migrating `isTask` to a true `kind: 'bullet' | 'task' | 'paragraph'` discriminant.**
Cleaner domain (illegal states unrepresentable), but ADR 0044 priced touching `isTask` at ~40 files
across the wire schema, the DO's persisted rows, MCP tools, OPML, and the todos plugin — for a
display feature. The cost of the additive shape is a permanent two-field discriminant, paid for
with two rules:

- **Exclusivity lives in the mutation funnels, not the type.** Setting `kind: 'paragraph'` clears
  `isTask`; any make-it-a-task gesture (`/todo`, the `[]`/`[ ] ` autoformat) clears `kind`. All
  writes already flow through these funnels.
- **Render tie-break: `kind` outranks `isTask`.** If a stale client or raw PATCH ever produces
  `isTask && kind === 'paragraph'`, the row renders as a paragraph (no checkbox) and the next
  kind-touching edit normalizes the pair.

**Rejected: a side-collection.** `outlineToMarkdown`, the MCP planner (`outline-ops.ts`), and OPML
are pure over the `TreeIndex` and cannot see side-collections; a cross-store exclusivity invariant
against `isTask` has no enforcement point. Kind is node identity, not plugin data.

## The pilcrow IS the dot — a core glyph swap, not a plugin seam

Same element, same handlers, same coarse-pointer hitbox, same hover affordance — only the glyph
changes when `kind === 'paragraph'`. Click zooms, press-and-drag reorders, exactly as the dot
(ADR 0029: the dot is the sole touch zoom target — the pilcrow inherits that job wholesale, which
is what the rejected PR #177 signifier-replacement lacked). The `row:bullet` plugin seam PR #177
proposed stays dead: core swaps its own glyph on its own core field, the same pattern as
fade-inheritance reading `completed`. No `paragraphs/` plugin folder — a plugin that couldn't own
its signifier would be a folder with one command in it.

Watch the ADR 0029 optical-alignment K-constants: the pilcrow's glyph height differs from the
dot's, so it needs its own `margin-top` K, verified against the e2e alignment assertion.

**Both render paths:** a zoomed paragraph shows a small, muted, non-interactive pilcrow at the
`title:before-text` position (the todos-checkbox/daily-badge precedent) — without it a zoomed
paragraph is indistinguishable from a zoomed bullet and the toggle command has no visible state.

## Editing semantics

- **Enter inherits kind** — at end of a paragraph the new sibling is a paragraph; a mid-text split
  leaves two paragraphs. Byte-for-byte the existing `isTask` carry-forward in `insertNodeAfter`.
- **The todos autoformat converts** — typing `[]`/`[ ] ` at the start of a paragraph makes it a
  task (`isTask: true`, `kind: null`) in one funnel write. Conversion always, combination never.
- **Creation:** `/paragraph`, a **core** `CommandSpec` (whole-node, so Cmd+K lists it for free)
  with `runMany` for batch conversion from the selection menu (the todos To-do shape). `/bullet`
  gains one more job: it clears `kind` too — one command meaning "back to a plain bullet, whatever
  you were". No dedicated hotkey and no mobile-bar button in v1.

## Markdown: paragraphs round-trip as marker-less lines

Markdown already has paragraph syntax — a bare line. A paragraph exports as its text with **no
`- ` prefix**; the parser maps a marker-less line at depth _d_ to a paragraph node. This amends
ADR 0044's "one line, one bullet" (see the amendment there for the grammar mechanics and guards)
and keeps `parse(outlineToMarkdown(t)) === t` real for kind, the same way `[ ]` keeps it real for
task-ness — honoring "markdown is the interchange format for node state, never its storage".
Accepted consequence: multi-line prose pastes now land as paragraphs, not bullets.

**Rejected: kind lost on copy (a fourth round-trip exception).** It would have been the first
exception to silently drop node state rather than shift presentation.

## Agent + OPML boundary: exposed from day one

- **MCP:** optional `kind` on `add_node`/`add_subtree`/`update_node` (Effect Schema
  `Literal("paragraph")`), surfaced in `get_outline`/`search_nodes`. `outline-ops.ts` enforces the
  same normalization as the client funnels, so exclusivity holds at the trust boundary. (Tool
  schema changes mean updating the ordered tool-name list in `worker/mcp.test.ts`.)
- **OPML:** a `_kind="paragraph"` attribute in the `_task`/`_complete` convention — absent means
  bullet, so foreign OPML and old exports import unchanged.
