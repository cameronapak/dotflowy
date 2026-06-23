# ADR 0015: Tag filtering (click a `#tag` to prune the subtree)

Status: accepted (2026-06-22), implemented. The `#` **autocomplete** landed with the first cut
(see *Addendum*). Tag **colors** also landed but were promptly reworked from derived to
**chosen** -- see [ADR 0016](./0016-custom-tag-colors.md).

Relates to [ADR 0012](./0012-node-quick-switcher.md) (the Cmd+K jump-to switcher), which this
narrows but does not supersede — see *Two search surfaces, two jobs* and the amendment note added
to 0012.

## Glossary

- **Tag** — an inline token in a node's text of the form `#name`, parsed out of `node.text` at
  read time. It is **not a stored field** — the `#important` lives literally in the text, exactly
  like an inline `` `code` `` run (ADR 0012's sibling pattern, `inline-code.ts`). Delete the node
  and its tags go with it; no schema field, no migration.
- **Tag chip** — the rendered, **clickable** form of a tag inside the contentEditable bullet/title.
  Same decoration path as the code chip (`decorate()` / `inlineMarkupHtml()`), but interactive:
  a plain click **adds the tag to the filter**, it does **not** place an editing caret.
- **Filter** — an ordered **set** of active tags, AND-ed. A node is *in* the filter result iff
  **its own text** contains **every** active tag (per-node, not per-subtree). Lives in the URL as
  a search param so it is reload-safe, shareable, and part of back/forward.
- **Pruned tree** — what the outline renders while a filter is active: matching nodes shown
  normally, **plus their ancestors** as dimmed context, with every non-matching, non-ancestor
  branch hidden. The outline shape is preserved (an outliner without structure is just a list).
  See *Reveal = pruned tree, not flat list*.
- **Filter bar** — the row of **tag pills** that appears (near the header) only while a filter is
  active. Each pill has a ✕ that drops that one tag; a clear-all drops the whole filter. This is
  the "search bar showing the selected tag" from the request. It is **display + removal only** in
  v1 — tags are *added* by clicking chips, never typed (see *Click adds, the bar removes*).

## Decision

A node's text is decorated so each `#tag` renders as a **clickable chip** (in both bullets and the
zoomed title). **Clicking a chip AND-s that tag into a URL-driven filter** scoped to the current
zoom root; the outline re-renders as a **pruned tree** (matches + ancestor context, everything else
hidden). A **filter bar of tag pills** appears while the filter is active: click a pill's ✕ to drop
one tag, clear-all (or Escape) to drop the filter and return to the normal outline.

Match semantics: **per-node AND** — a node matches iff its own text contains *all* active tags.

State: a single search param, `q`, holding the active tags space-separated (e.g.
`/$nodeId?q=%23important+%23urgent`, and `/?q=...` at home). **Validated on both `routes/index.tsx`
and `routes/$nodeId.tsx`** via one shared `validateSearch` schema — TanStack Router's native typed
search params, **no nuqs** (see *Why TanStack search params, not nuqs*).

The filter is **render-time only**: it computes a visible-set from `q` + the tree and never mutates
any node — in particular it never touches `collapsed`. So collapsed subtrees with matches inside are
revealed *while filtered*, and clearing the filter restores the exact prior collapse state for free
(nothing was changed to restore).

### Scope is the zoom root, because `q` is per-route

"Within the focused node and all its children" falls out of the existing zoom model for free: the
filter is evaluated against the current `rootId`'s subtree, and because `q` is a search param on the
route, zoom and filter **compose** — zoom in, then filter, and the filter narrows what you zoomed
into. No separate "scope" concept to carry.

### Reveal = pruned tree, not flat list

A node is visible while filtered iff it **matches** or **has a descendant that matches**. Matches
render with normal styling; ancestor-only nodes render **dimmed** (context, so you can see *where*
each match lives). A flat list of hits was rejected: it throws away the structure that makes an
outliner worth using, and it can't show "this match is under Work › Q3."

### Click adds, the bar removes (v1 is click-driven, tags-only)

The **only** way to add a tag to the *filter* in v1 is **clicking a chip** in the outline. No
typing into the bar, no tag-picker in the bar. (The `#` autocomplete in the addendum helps you
*author* tags in a node's text — it does not add to the filter.) The bar exists to **show** the
active tags and **remove** them. This keeps v1 honest — clicking is the whole interaction — and keeps the bar a
pure pill display with no text-entry UX to design.

Accreting by click is also why a second click ANDs rather than replaces: clicking `#urgent` while
already filtered on `#important` yields `#important #urgent` (both), mirroring Workflowy. Switching
filters is "clear, then click," not a special replace gesture.

### Clicking a chip filters; it does not place a caret

Tags live inside a `contentEditable`, where a plain click normally just drops the editing caret.
That pixel is contested: the feature *is* "click the tag to filter." We resolve it by making the
chip a real interactive element whose pointer interaction is intercepted (`preventDefault` on the
chip) and routed to the filter — **a plain click on a chip never places a caret**.

The tradeoff: you can't click into the middle of `#important` to fix a typo. You edit a tag by
placing the caret just before/after the chip and using arrows/backspace (it's plain text — backspace
from the trailing edge eats it character by character), exactly the awkwardness the code chip already
has. Workflowy accepts this same tradeoff. Tags are short; retyping is cheap; the click-to-filter
affordance is the entire point. Modifier-click (plain edits, Cmd-click filters) was rejected as
undiscoverable — nobody expects it.

### Two search surfaces, two jobs

This filter and the Cmd+K **jump-to switcher** (ADR 0012) are different jobs and both stay:

| Surface | Job | Behavior |
| ------- | --- | -------- |
| **Cmd+K switcher** (0012) | **Go somewhere else** | Fuzzy (Fuse), ranked, transient; pick a result and it **navigates away** to that node's zoom view. |
| **Tag filter** (this ADR) | **Narrow what's in front of me** | Exact tag match, structural prune, sticky/URL-driven; **keeps you where you are**. |

In v1 the header **magnifier is unchanged** — it still opens the jump-to switcher. Because v1 adds
no free-text typing, the filter needs **no input field**, so it does not touch the magnifier or
Cmd+K at all. The only new header element is the pill bar, and it shows only when a filter is active.

### Edge cases / invariants

| Situation | Behavior |
| --------- | -------- |
| What counts as a tag | `#` preceded by **start-of-text or whitespace**, then `[\p{L}\p{N}_-]+`, ending at the next space/punctuation. `#work-q3` ✅, `#важно` ✅, `foo#bar` ❌, bare `#` ❌. |
| `@`-mentions | **Deferred.** v1 parses `#` only. |
| Collapsed match | **Revealed while filtered.** Filtering is render-time; `collapsed` is untouched, so clearing the filter restores collapse state exactly. |
| Completed match | Respects the existing **show-completed** toggle (ADR 0002) — a completed match shows only if show-completed is on. The filter does not override it. |
| Zero matches | A "no nodes tagged `#x` here" message; the **pills stay** so you can clear or drop a tag. |
| Edit while filtered | Allowed. Strip the `#important` from a node that only matched because of it and the node **drops out on the next render**. Known rough edge (Workflowy does the same). |
| ✕ on a pill | Removes **that one tag** from `q`. |
| Clear-all / Escape | Drops the whole filter → normal outline. **Escape only clears when the bar/outline holds focus**, never while the caret is mid-edit in a bullet (don't let Escape eat an edit). |
| Filter + zoom | Compose. Filter is evaluated within the current `rootId`; both live in the URL. |
| Tag in the zoomed title | Renders as a chip and is clickable too — same decoration path as bullets. |

## Addendum: tag colors + `#` autocomplete

Two authoring affordances shipped with the first cut. Neither changes the filter model above
(the filter is still grown only by clicking chips) — they make tags nicer to *read* and to *type*.

### Tag colors

**Superseded by [ADR 0016](./0016-custom-tag-colors.md).** This cut first shipped *derived* colors
(a hash of the tag name → a fixed palette), but that was replaced before it mattered: tags now
default to a **neutral outline** and a color is **chosen** per tag and stored. See ADR 0016 for the
model, the storage decision, and the picker gesture.

### `#` autocomplete completes existing tags

Typing `#` opens a popover of **existing tags across the outline** (each rendered as its colored
chip), filtered as you type; Enter / Tab / click completes one. It's the **same machinery as the
`/` command menu** (`useSlashMenu`) — caret-trigger detection, a portaled menu at the caret,
arrow/enter/tab/escape, mousedown-to-keep-focus — refactored so both share the caret helpers. The
two coexist (`#` vs `/` triggers; at most one open; the tag menu gets first crack at keys). It
**only opens when there's a match**, so a brand-new tag never pops an empty box — new tags are made
by just finishing typing (no "create" row in v1). The corpus is read live from the shared tree
index via `collectAllTags`.

- **Rejected: a "Create #foo" row.** Tidy, but typing already creates the tag; the row is noise for
  v1. Easy to add later.
- **Still deferred:** `@`-mentions, and **free text in the filter bar** (the `q` param stays
  tags-only) — see *Rejected alternatives*.

## Why

- **Parsed, not stored** — zero schema change, no `collection.ts` migration, tags delete with the
  node. The `inline-code.ts` decoration already proves "raw markdown is the source of truth, render
  formatted HTML live"; tags are the second tenant of that exact mechanism.
- **URL-driven** — matches the existing zoom model (`rootId` is route-owned precisely so view state
  survives reload and back/forward). The filter is the same kind of view state, so it belongs in the
  same place. Scope-to-subtree then comes for free because `q` is per-route.
- **Per-node AND** — clicking accretes, and "both tags on the same node" is the Workflowy behavior
  and the intuitive one. The matcher is a one-liner: `tags.every(t => text.includes(t))`.
- **One decoration site** — bullets and the zoomed title both already call `decorate()`, so tags
  light up in both from a single change to `inlineMarkupHtml()`.
- **Render-time prune, no mutation** — never touching `collapsed` means clearing the filter is
  literally "drop `q`"; there is no collapse state to save and restore.

### Why TanStack search params, not nuqs

TanStack Router has first-class **typed** search params (`validateSearch`, `useSearch`,
`navigate({ search })`) — end-to-end typed, already in the app. nuqs exists to bring this ergonomic
to routers that *lack* it (Next, plain React Router); it would be a dependency wrapping something the
router does natively. No reason to add it.

## Rejected alternatives

- **`tags: string[]` field on `Node`.** Fast lookup, but adds a schema field, a `collection.ts`
  backfill migration, and a perpetual text↔field sync problem. Parsing from text has none of these
  and the scan is cheap at this app's scale (same envelope as `buildTreeIndex`). Rejected.
- **Ephemeral React filter state.** Simpler to write; loses reload, back/forward, and shareable
  links, and fights the URL-owned zoom model. Rejected for the search param.
- **Flat list of matches.** Easier render, but discards outline structure and the "where does this
  match live" context. Rejected for the pruned tree.
- **Single-tag filter (click replaces).** Less code, but clicking a second tag *replacing* the first
  is not what Workflowy does and not what's wanted — accretion (AND) is the feature. Rejected.
- **Free text in the filter bar (v1).** Wanted eventually ("it's both"), but it adds text-entry UX,
  a tags-vs-text parse of `q`, and overlap with the Cmd+K switcher. **Deferred, designed-in:** when
  it lands, the header magnifier morphs into the filter input, free-text matches as
  case-insensitive **substring** (per-node, same prune — *not* fuzzy, since a structural tree has no
  ranking slot), and Cmd+K stays the fuzzy ranked jump-to. Cut from v1 the way ADR 0012 cut recents.
- **Modifier-click to filter (plain click edits).** Undiscoverable; nobody expects Cmd-click on a
  tag. Rejected — plain click filters.
- **Folding the filter into the Cmd+K switcher.** Different job (jump away vs narrow in place),
  different match model (fuzzy ranked vs exact structural). Conflating them muddies both. They
  coexist with a clear division of labor.

## Known rough edges

- **Can't click into the middle of a tag to edit it.** Edit from the chip's edges (arrows/backspace)
  or retype. Same constraint the code chip already has; accepted.
- **A node can drop out of the view while you're editing it** (you removed the tag that matched).
  Matches Workflowy; accepted.
- **No `@`-mentions and no free text in the filter bar** in v1 — deferred. (`#` autocomplete and
  tag colors *did* ship — see the addendum.)
- **No test runner** (AGENTS.md); `typecheck` is the only static gate. Walk by hand: type
  `#important` in a bullet → it renders as a chip; click it → URL gains `?q=%23important`, outline
  prunes to matches + dimmed ancestors, pill bar shows `#important`; click a second tag → both pills,
  AND-ed; ✕ a pill → that tag drops; Escape with the bar focused → filter clears and collapse state
  is intact; zoom first, then filter → filter stays within the zoomed subtree; reload → filter
  survives; a collapsed branch with a match inside is revealed while filtered.

## What changed

- **`src/data/tags.ts`** (new) — the pure tag layer: `parseTags`, `parseQuery`/`serializeQuery`,
  `matchesAllTags`, `buildTagFilter` (the prune: matches + ancestors within `rootId`),
  `validateOutlineSearch`, and the color/corpus helpers `tagColorIndex` / `tagColorClass` /
  `collectAllTags`.
- **`src/components/inline-code.ts`** — `inlineMarkupHtml()` now tokenizes code runs **and** `#tags`
  in one pass; tags render as `<span class="tag rounded-full … tag-cN" data-tag>` chips (color from
  the derived palette class). Reuses `TAG_PATTERN` / `tagColorClass` from `tags.ts`.
- **`src/components/tag-menu.tsx`** (new) — `useTagMenu`, the `#` autocomplete; mirrors
  `useSlashMenu` and reuses its caret helpers (now exported from `slash-menu.tsx`).
- **`src/components/OutlineNode.tsx`** — takes the `filter` prop (prunes visible children, dims
  ancestor context, ignores `collapsed` while filtering); wires `useTagMenu` alongside `useSlashMenu`.
- **`src/components/OutlineEditor.tsx`** — reads `q` via `useSearch`; builds the filter; mounts the
  `TagFilterBar` (pills colored by `tagColorClass`); delegated chip-click routing
  (`onMouseDown` blocks the caret, `onClick` AND-s the tag into `q`); Escape-to-clear; empty state.
- **`src/routes/index.tsx` + `src/routes/$nodeId.tsx`** — shared `validateSearch` for `q`.
- **`src/styles.css`** — `.tag-cN` palette (light/dark), context dim (`data-context`), filter-bar /
  pill / autocomplete-row styles.
- **No schema change, no `collection.ts` migration, no new route.**
</content>
</invoke>
