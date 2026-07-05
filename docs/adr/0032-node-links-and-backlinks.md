---
status: proposed
---

# Node links + backlinks (`[[` wiki-links)

**What.** A **link** is an inline reference to another node, stored in the referring node's text —
a pointer you travel through (click → zoom to the target), never a window into the target's content.
A **backlink** is the reverse view: from a node, the set of nodes whose text links to it, surfaced
when that node is zoomed. Designed via `/grill-with-docs`, modeled on Notion's mention/backlink UX
(and WorkFlowy's internal links).

**The three-tier model this completes.** dotflowy now has three ways one node relates to another,
deliberately kept distinct: a **link** is "go there" (text-level, no content sharing), a **mirror**
([ADR 0022](./0022-node-mirrors.md)) is "lives here too" (node-level, fully synced instance). A link
must never grow mirror-like behavior (hover-expand of children, edit-in-place at the link site) —
that is exactly the A1/A2 fork ADR 0022 already resolved; links are the *feature* version of the A2
shape 0022 rejected as a *mirror implementation*.

## Decisions

**The token stores the node id; display is the target's live text.** Source text carries `[[<nodeId>]]`;
the renderer looks up the target and shows its *current* text. Rename-proof by construction — retitle
the target and every link updates everywhere (Notion stores page ids for the same reason). Rejected:
store the target's text, Obsidian-style (node text isn't unique, renames break every link, needs a
title→id resolution pass); store a snapshot label in a `[label](dotflowy://id)` markdown shape (the
frozen label lies the moment the target is edited — the #1 wiki-link complaint in tools that do this).
Consequence, accepted: raw source is not human-readable. Markdown export ([ADR 0017](./0017-markdown-export.md))
flattens a link to the target's text at export time; copying a bullet yields the `[[id]]` source slice
(re-folds when pasted back into dotflowy; opaque elsewhere — same tradeoff as export).

**The chip is a BibleChip-class atom, not a revealing token.** Rendered as a Seam A **widget** token
([ADR 0006](./0006-react-token-widgets.md)): the mounted component subscribes via `useNode(targetId)`,
which is what makes the live label possible at all — a plain `El` token can't, because the decorate
cache is keyed on the source string, which never changes when the *target* is renamed. No caret reveal
(revealing exposes a raw id — noise, not editing power); arrows step over the whole chip; **backspace
deletes the entire token**, which is also v1's unlink story. Display clamps at ~40 chars with an
ellipsis; a hover `title` shows the target's breadcrumb (the only way to see where a link points
without navigating). Click zooms to the target via the `$nodeId` route (Seam B) — a real URL
navigation, so the view-transition morph comes free. Styled in the rich-link family but with an
internal marker (a `[[` glyph / node icon) instead of a favicon.

**`[[` opens a picker; no create-on-no-match in v1.** The trigger is a Seam H caret menu (the `#`
autocomplete shape), fuzzy over node text reusing the Cmd+K Fuse setup; typing after `[[` filters;
the picker excludes the current node (no self-links). On no match, nothing is offered and the literal
text stays plain — link creation requires an existing target. Rejected for v1: Notion's "create new
page from the picker," because an outline has no obvious home for a node conjured from a picker
(root? current node? today?), and answering that properly is a container decision (a Links/Inbox
container, like the Daily container) that deserves its own design, not a smuggled-in default.

**Backlinks are derived, zoomed-only, and quiet.** No storage on the target — the index is computed
by parsing `[[id]]` tokens out of node text, a `targetId → referring node ids` reverse index
maintained in the tree-store exactly like the mirrors reverse index. Deduped by referring node (one
node linking twice = one backlink). Surfaced **only in the zoomed view**: a quiet `{n} backlinks`
affordance under the zoomed title, rendering nothing at zero, opening the mirror-places-style list
(referring node's text + breadcrumb, click to jump). It joins the **same visual family as the mirror
"×N places" chrome** — one grammar for "this node's edges." Rejected: Roam/Obsidian's always-expanded
"Linked references" section (the loudest possible answer in a deliberately quiet outline; Notion's
collapsed count proves it unnecessary) and per-row backlink chrome in the list (fights the
node-decoration budget, [ADR 0031](./0031-two-lane-plugin-governance.md), for information rarely
needed mid-list).

**Deleting a linked-to node degrades; it never blocks and never rewrites referrers.** The delete
proceeds; orphaned tokens render as a generic "missing link" chip (the target is gone, so there is no
text to subscribe to); undo restores the target and every chip heals automatically — the id-pointer
model paying off. This diverges from mirrors on purpose (mirrors *protect* because deleting a source
destroys content that visibly lives elsewhere; a link is a pointer — nothing is lost but the
destination). Rejected: block the delete (punishes the best-connected outlines) and cascade-clean the
referrers' text (silently mutates nodes the user didn't act on, and makes delete-undo restore N
unrelated nodes' text).

**Plugin/core split: the plugin owns the UX, core owns the format.** A new `src/plugins/node-links/`
owns the Seam A widget, Seam B click, and Seam H picker (separate from the `links` plugin — external
URLs and node links share almost no logic: no fold/reveal, no unfurl, no bracket editing). Pure
parsing + the reverse index live in `src/data/node-links.ts` (the `src/data/tags.ts` precedent). The
under-title backlink chrome is **core**, beside the mirror-places chrome — consistent with ADR 0022's
call that this family is core, and honestly resolving the dependency inversion: core chrome may not
depend on a plugin's token format, so **`[[id]]` is a core-known convention** like `#tag` grammar.
No `title:below` seam is invented for it — per the ADR 0031 governance bar, a seam is extracted when
a second consumer proves it.

## Scope notes

- **No new MCP tools.** Agents already see node ids in `get_outline` and can write `[[id]]` through
  `update_node`/`add_node`; backlinks derive automatically.
- Cmd+K search indexes the *flattened* label (the target's text), not the raw `[[id]]` — the
  `flattenInline` chain grows an index-aware step.
- The picker's empty state says "no matching node"; Escape leaves the typed literal untouched, like
  an unmatched `#tag`.
