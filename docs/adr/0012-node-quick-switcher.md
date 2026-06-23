# ADR 0012: Node quick-switcher (Cmd+K fuzzy jump-to)

Status: accepted (2026-06-22), implemented. **Narrowed (not superseded) by
[ADR 0015](./0015-tag-filtering.md):** the switcher is now one of **two** search surfaces. It keeps
its job — the **fuzzy, ranked, navigate-away jump-to** ("go somewhere else") — unchanged. The new
**tag filter** owns the other job — exact-match, structural prune, sticky/URL-driven ("narrow what's
in front of me"). v1 of the filter adds no free-text input, so the magnifier and Cmd+K here are
untouched; if free text later lands in the filter (ADR 0015's deferred work), the magnifier morphs
into the filter input and Cmd+K stays the fuzzy jump-to described below.

## Glossary

- **Quick-switcher** — a transient dialog that fuzzy-searches every node by its text and
  navigates to the chosen node's *zoom view* (`/$nodeId`). It is a **jump-to**, not a command
  palette: v1 runs **zero actions**, only navigation. Named honestly so we don't imply
  "run commands" we don't yet cash. See *Why "quick-switcher", not "command palette"*.
- **Fuzzy search** — typo-tolerant, rank-by-relevance matching via **Fuse.js** over a single
  key: `node.text`. Not substring (`like`/`ilike`) — TanStack DB has no fuzzy primitive, and
  substring gives no ranking, no typo tolerance, no match ranges to highlight.
- **Breadcrumb context** — the ancestor chain shown beneath each result (`Work › Q3 › Notes`)
  so a bare title like "Notes" is disambiguated. Built from the same `buildTrail()` the zoom
  breadcrumb uses (ADR 0003). It is **displayed, not searched** (see *What Fuse matches*).
- **Empty-query state** — what the list shows before you type: the **bookmarks**, newest-first,
  identical sort to ADR 0011's popover. Deliberately *not* "recently visited" (see *Why no
  recents in v1*).
- **Match highlight** — the matched characters of a result's title wrapped in `<mark>`, driven
  by Fuse's `includeMatches` index ranges.

## Decision

A global **Cmd+K** (and a **header search button** for touch) opens a `CommandDialog`
(shadcn/cmdk) that fuzzy-searches all nodes by `text` via Fuse.js and navigates to the picked
node's zoom view. Empty query shows bookmarks. Each result shows its breadcrumb ancestry and
highlights the matched characters. **No new `Node` field, no migration** — it reads the
existing collection.

### Why "quick-switcher", not "command palette"

The component cmdk ships is literally called `CommandDialog`, and the instinct is to call this
a command palette. We don't, because v1 has **no commands** — every row is a node you navigate
to. Calling it a palette writes a check (run actions, not just jump) we aren't cashing, and it
muddies the empty-state design (a real palette lists actions; a switcher lists places to go).
It will *grow into* a command palette later — cmdk already supports mixing action rows in — at
which point this ADR gets a successor. For now the name matches the behavior.

### Why no recents in v1

The request floated "bookmarked **and** recently-zoomed nodes" for the empty state. Recents got
cut. The reason is structural:

- A **bookmark is content** — a field on the node (`bookmarkedAt`, ADR 0011), so it deletes with
  the node and needs no side table. "Recently visited" is **session ephemera** with no such home.
- Powering it would cost one of: **(A)** a new `lastVisitedAt` field written **on every zoom
  navigation** — a DB write on the hot path of the app's most common action, plus a new
  "mutation that deliberately doesn't bump `updatedAt`" — or **(B)** a localStorage id-list, the
  exact dangling-reference side table ADR 0011 argued against.
- The user's own framing was "honestly bookmarked is probably the best"; recents was the hedge.

So v1 ships the 95% feature with **zero new state**. If a bookmarks-only empty state feels thin
in real use, recents come back as **(B)** localStorage — *not* (A) — because recents are
view-state, which is localStorage's job, not the content collection's. Resolving stale ids at
read time is cheap; polluting every navigation with a write is not.

### What Fuse matches (and what it doesn't)

- **Searches `node.text` only.** Typing the thing's own name is what people do.
- **Does not search the breadcrumb path.** Indexing a composite `"Work Q3 Notes"` string was
  considered and rejected: every node would inherit its ancestors' words, so searching "Work"
  returns the entire subtree ranked by noise and Fuse's scoring goes mushy. The breadcrumb is
  there to **read** a result, not to **match** it.
- **Empty-text nodes are excluded** from the index — they can't meaningfully match and would be
  blank rows.
- **Completed and collapsed nodes ARE searchable.** The whole point is jumping to something you
  *can't currently see*. A completed result renders with the outline's completed styling
  (dimmed + line-through) so its state is legible before you jump; selecting it zooms it to root,
  where it's visible regardless.

### Fuse configuration

```
keys: ['text']
includeMatches: true      // index ranges → highlight
ignoreLocation: true      // CRITICAL: without it Fuse penalizes matches late in the
                          // string, so "notes" would miss "Weekly team notes"
threshold: 0.3            // tight enough to avoid garbage, loose enough for typos
minMatchCharLength: 2
```

The Fuse index is **memoized on the node list** (rebuilt only when the collection changes) and
**re-searched per keystroke**. Results are **capped at 50** to bound the DOM. Perf envelope is
the same as the tree index: fine to low-thousands of nodes; revisit if it ever gets slow.

### Two entry points, one dialog

| Trigger | For | Notes |
| ------- | --- | ----- |
| **Cmd+K / Ctrl+K** | Desktop | Global **capture-phase** keydown listener — fires even while the caret is inside a `contentEditable` bullet, `preventDefault`s before the editor's handlers see it. Toggles open. |
| **Header search button** | Touch (and desktop) | A magnifier in the header's global action group. Phones have no Cmd+K, so without this, touch users have **no search at all**. |

The dialog is mounted **once** in `__root.tsx` (available on every route). The header button is
far from it in the tree, so it opens the dialog through a tiny module-level `openNodeSwitcher()`
(the mounted dialog registers its setter; the button calls it) rather than threading state or
adding a context provider — same spirit as the module-level history stack.

### Invariants

| Situation | Behavior |
| --------- | -------- |
| Empty query | Show **bookmarks**, newest-first. If none: a hint to start typing. |
| Query typed | Show Fuse results (≤50), highlighted; "No matches" otherwise. |
| Result is a completed node | Row renders **dimmed + line-through**; still selectable. |
| Pick a result | **Plain nav to `/$nodeId`** — no zoom **morph** (ADR 0003): a result row isn't the pivot dot the morph animates from. Dialog closes. |
| The current zoom root appears in results | **Kept, not filtered.** Navigating to where you already are is a harmless no-op and felt like the most predictable behavior (an explicit call — filtering it was the alternative). |
| Node text empty | Excluded from the search index entirely. |
| Open mid-edit, then Escape without picking | Dialog closes; caret does **not** return to its exact prior spot (the dialog took focus). Accepted for v1 — see *Known rough edges*. |

## Why

- **Almost everything already exists.** `cmdk` + `ui/command.tsx` are in the repo; `lucide-react`
  for the icon; route-based zoom (`Link to="/$nodeId"`) is the navigation; `buildTrail()` already
  computes ancestry for the zoom breadcrumb. The only genuinely new dependency is **Fuse.js**
  (~5kb, zero deps, does not import React — so the dep-optimize React-dupe gotcha in AGENTS.md
  doesn't apply).
- **Fuse over TanStack `like`.** Substring matching gives no relevance ranking, no typo
  tolerance, and no match ranges to highlight. Fuzzy search is the feature; Fuse is the smallest
  thing that delivers it.
- **cmdk's own filter is turned off (`shouldFilter={false}`).** We drive the list from Fuse
  because cmdk's built-in matcher is weaker (and we want Fuse's ranking + match ranges). cmdk
  still gives us free keyboard nav (arrows / Enter) and the dialog's input auto-focus.
- **Zero schema change.** Cutting recents means no new `Node` field and **no `collection.ts`
  migration** — unlike bookmarks (ADR 0011). Pure UI addition.
- **`buildTrail` belongs in `tree.ts`.** It was module-private in `OutlineEditor`, but it's a
  pure index walk and now has a second caller. Promoting it (and re-importing it into the editor)
  is the honest home; no behavior change.

## Rejected alternatives

- **TanStack DB `like`/`ilike` live query instead of Fuse.** No ranking, no typo tolerance, no
  highlight ranges. It's substring filtering, not search. Rejected.
- **cmdk's built-in filtering.** Weaker matcher than Fuse and no relevance score exposed for our
  ordering. We keep cmdk for the shell (dialog, keyboard nav, a11y) and replace its brain.
- **Recents in the empty state (v1).** Cut — see *Why no recents in v1*. If revived, localStorage
  id-list (view-state), never a `lastVisitedAt` field (a write on every navigation).
- **Searching the composite breadcrumb path.** Inflates false matches and muddies scoring; the
  path is for reading, not matching. Rejected.
- **Naming it a "command palette" now.** v1 runs no commands; the name would overpromise. Held
  for a successor ADR when action rows actually land.
- **Filtering the current zoom root out of results.** Considered (a row that navigates you to
  where you already are is a dead click), but keeping it felt more predictable and is a harmless
  no-op. Explicit call, not an oversight.

## Known rough edges

- **Caret doesn't return after a no-pick Escape.** Open mid-edit, dismiss without choosing — the
  dialog stole focus and we don't restore the exact caret. Acceptable; a focus-restore is the
  additive fix if it bites.
- **Highlighting is title-only.** The breadcrumb context isn't highlighted (it isn't searched).
  Fine, since matches only ever occur in the title.
- **50-result cap is silent.** A query matching hundreds shows the top 50 by Fuse score with no
  "and N more" marker. Revisit if it matters.
- **No test runner** (AGENTS.md). `typecheck` is the only static gate. Walk by hand: Cmd+K opens
  with caret in a bullet; header magnifier opens the same dialog; empty query lists bookmarks
  (or the hint); typing fuzzy-matches with highlights; a completed node shows dimmed/struck and
  still navigates; breadcrumb context renders for a deep node; Enter and click both navigate and
  close; Escape closes.

## What changed

- **`src/data/tree.ts`** — `buildTrail(index, rootId)` promoted here (was private in
  `OutlineEditor`), exported. Pure ancestor walk, no behavior change.
- **`src/components/OutlineEditor.tsx`** — imports `buildTrail` from `tree.ts`; local copy removed.
- **`src/components/node-switcher.tsx`** (new) — self-contained, mirroring the `bookmarks.tsx`
  pattern:
  - **`NodeSwitcher`** — the `CommandDialog`. Owns `open`/`query` state, the global capture-phase
    Cmd+K listener, the Fuse index (memoized on the live node list), result rendering with
    breadcrumb + highlight, and navigation on select. Mounted once in `__root.tsx`.
  - **`NodeSearchButton`** — the header magnifier; calls the module-level `openNodeSwitcher()`.
  - **`openNodeSwitcher()`** — module-level opener the button uses to reach the mounted dialog.
- **`src/components/Header.tsx`** — `NodeSearchButton` added to the global action group.
- **`src/routes/__root.tsx`** — mounts `<NodeSwitcher />` once, inside the providers.
- **`package.json`** — adds `fuse.js`.
- **No schema, no `collection.ts` migration, no new route.**
