<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `bunx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# Project Guidance

This file provides guidance to coding agents (Claude Code, and any tool reading `AGENTS.md`) when working with code in this repository. `CLAUDE.md` is a symlink to this file.

The `README.md` covers the data model, persistence, backend-swap path, and project layout well — read it first and don't duplicate it here. This file is the stuff that isn't obvious from reading any single file.

## Documentation Freshness

Repo reality is the source of truth. If `AGENTS.md` or `README.md` becomes false, update it in the same change when the fix is objective.

Objective facts include repo structure, tracked paths, setup commands, validation commands, runtime/tooling, skill/resource/prompt inventory, and workflow constraints proven by the repo.

- Update `AGENTS.md` when it is stale about agent-facing repo reality.
- Update `README.md` when it is stale about human-facing purpose, entry points, install, or use.
- Ask before changing policy, philosophy, positioning, or workflow intent.
- If both docs are stale, update both. Do not make them mirror each other unless the same fact belongs in both.
- Ignore temporary, generated, local-only, and unrelated untracked files.
- If unrelated user changes make docs look stale, ask before broadening scope.
- After repo-reality changes, check `AGENTS.md` and `README.md` before finishing.
- In the final response, mention any freshness updates.

## Planning and design

Substantial plans or design decisions go through `/grill-with-docs` — a relentless
interview that sharpens the design and produces docs as it goes. Its output lands in
`docs/adr/`: a numbered ADR per decision, with a glossary and an explicit "why" (see
`docs/adr/0001`–`0006` for the format).

- Keep ADRs as the home for *decisions + rationale + rejected alternatives*. AGENTS.md
  holds only the operational rule plus a link to the ADR.
- When a decision changes, add a new ADR (or supersede an existing one) rather than
  rewriting history; update the AGENTS.md pointer to match.

## Commands

```sh
bun run dev        # vite dev on :3000 (or next free port)
bun run build      # production build (also prerenders /)
bun run typecheck  # tsc --noEmit
bun run test:e2e   # playwright (chromium) end-to-end tests
bun run test:e2e:ui  # same, in Playwright's interactive UI
```

There is **no unit-test runner and no linter** configured; `typecheck` is the only static gate — run it after any change. End-to-end behavior is covered by **Playwright** (`e2e/`, chromium-only, boots the Vite dev server on port 3210 and reuses one already running locally). Specs seed a deterministic tree straight into localStorage via `seedOutline` in `e2e/fixtures.ts` — the on-disk shape is TanStack DB's `{ "s:<id>": { versionKey, data } }`, not a `Node[]`. The `e2e/` dir is outside `tsconfig.json`'s `include`, so Playwright files don't affect `typecheck`. The README lists the npm scripts.

**Positioning the caret in a contentEditable test:** don't use `Home`/`End`/arrow keypresses to place the caret — on macOS Chromium they don't reliably move it inside a contentEditable, and a plain `.click()` lands *past* the bullet text (the `.node-text` span is wider than its text). Set the Selection range directly via `evaluate` (walk text nodes to the target offset, like the app's own `setCaretOffset`); see the `caretAt` helper in `e2e/enter-split.spec.ts`. Also note `toHaveText` normalizes whitespace, so leading/trailing spaces won't assert — prefer space-free fixture text (`"alphabravo"`) or `allTextContents()` for exact, un-normalized comparisons.

## Generated files

- `src/routeTree.gen.ts` is **auto-generated** by the TanStack Start Vite plugin. Never hand-edit it. After adding/renaming a file in `src/routes/`, it regenerates when the dev server (or build) runs — start `bun run dev` once to refresh it, otherwise `typecheck` fails on `to: '/$nodeId'`-style typed routes before the file is updated.

## SPA mode

No SSR — don't run code that touches `nodesCollection` during a server/render pass. Why: [ADR 0004](./docs/adr/0004-spa-only-no-ssr.md).

## Data layer gotchas

- **localStorage shape is not a plain array.** Under key `dotflowy-oss:nodes`, TanStack DB stores an object keyed by id where each value is `{ data: Node, versionKey }` — not `Node[]`. To read it directly: `Object.values(JSON.parse(raw)).map(v => v.data)`.
- **Build nodes via `makeNode()` in `tree.ts`.** Don't add zod `.default()` values to `src/data/schema.ts`. Why: [ADR 0005](./docs/adr/0005-no-zod-defaults-in-schema.md).
- **Mutations operate on the live `TreeIndex`.** Every function in `mutations.ts` takes the current index (so it can find siblings/order) and mutates `nodesCollection` directly. The editor holds the live-derived index in a ref (`focusIndex`) and passes `focusIndex.current` into command handlers — the `commands` object itself is now `useMemo`-stable (it must be, since it's a prop on every memoized `OutlineNode`), so the refs are how its closures still read live values. See [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md).
- **Per-node subscriptions, not a threaded index.** Components read the tree through the **tree store** (`src/data/tree-store.ts`): `useNode(id)` and `useVisibleChildIds(parentId, showCompleted)` for narrow slices, `useTreeIndex()` (what `useTree()` wraps) for the whole index. `OutlineNode` takes a `nodeId` and reads its own slice, so a keystroke re-renders only the changed bullet, not the tree. Don't reintroduce passing `node`/`index` as props to `OutlineNode`. Why: [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md).

## Styling

Inline Tailwind classes, not a separate CSS file. Why: [ADR 0006](./docs/adr/0006-inline-tailwind-styling.md).

## Editor internals (OutlineEditor + OutlineNode)

These two files have a few coupled patterns worth knowing before touching them:

- **`OutlineNode` is a memoized wrapper + a body.** The exported `OutlineNode` is `memo`'d, calls `useNode(nodeId)`, and early-returns when the node is gone; everything else lives in `OutlineNodeBody`. Keep all other hooks in the body so the wrapper's single pre-return hook stays rules-of-hooks-safe. Its memo only pays off while `commands`/`registerRef`/`pivotId`/`showCompleted` stay referentially stable — don't pass it a fresh object/callback per render. Why: [ADR 0014](./docs/adr/0014-localized-node-rendering-via-tree-store.md).
- **contentEditable text sync is manual.** The `node-text` / title spans are `contentEditable`, not controlled React values. Stored text is written to the DOM (`el.textContent = node.text`) only when it differs, to avoid clobbering the caret mid-typing; `onInput` pushes changes to the store. Don't convert these to React-controlled text.
- **The `refs` registry maps node id → contentEditable span.** It unifies focus and animation: list-item bullets register under their own id, and the zoomed **title registers under `rootId`**. So `refs.current.get(someId)` returns the right element whether that node is currently a title or a list item — focus movement, pending-focus-after-mutation, and the zoom morph all rely on this.
- **Enter splits the bullet at the caret.** Text left of the caret stays on the node; text to its right moves into a new sibling below, focused with the caret at its *start*. `OutlineNode` passes the caret's absolute offset (`getCaretOffset`) to `commands.onEnter`; the editor slices `node.text`, seeds the new sibling via `insertSibling(..., after)`, then `setText(id, before)`. Caret-at-end is just the empty-tail case (`after === ""`), so the older rule still holds: Enter at the end of an *expanded* parent dives in (child at top) rather than making a sibling. The whole split is one undo step (a single `capture` before it). That new-sibling-at-start caret is the lone exception to the otherwise end-of-text `pendingFocus` default — see `pendingFocusAtStart` in `OutlineEditor`. Covered by `e2e/enter-split.spec.ts`.
- **Keyboard expand/collapse is directional, not a toggle.** `Cmd+↓` only opens a closed bullet; `Cmd+↑` only closes an open one; every other cell is a silent no-op. Both always `preventDefault` (so the caret never jumps), one level only, focus stays on the parent. Why: [ADR 0007](./docs/adr/0007-keyboard-expand-collapse.md).
- **Arrow Up/Down crosses bullets from the edge *visual line* and preserves the caret column.** The cross test (`atLineStart`/`atLineEnd` in `OutlineNode.tsx`) compares the caret's rect to the element's rect, not text offset — so a single-line bullet crosses at any offset while a wrapped bullet still moves line-by-line internally. Landing uses `caretPositionFromPoint` to hit the same x; don't reach for a text-measurement library (the DOM already has the layout). The neighbor walk (`findVisibleNeighbor` → `flattenVisible` in `OutlineEditor.tsx`) **must mirror the render's visibility**: it skips completed nodes when `showCompleted` is off, same as `useVisibleChildIds` — otherwise it'd return an id with no mounted element and focus would silently no-op and pin. Why: [ADR 0008](./docs/adr/0008-column-preserving-caret-nav.md).
- **Cmd+Shift+↑/↓ moves a bullet among siblings; at the edge it outdents one level.** Swap with the nearest *visible* sibling (hidden completed ones are skipped, never a dead press); at the first/last visible child it pops out — up-edge to before its parent, down-edge to after it (the existing `outdent`). Never dives into a sibling subtree, never adopts siblings, no-op past the zoom root. `moveUp`/`moveDown` in `mutations.ts`. Why: [ADR 0009](./docs/adr/0009-move-node-among-siblings.md).
- **Dragging the bullet dot reorders *and* reparents in one drop** (mouse + touch). Pointer y picks the gap, pointer x picks depth (clamped to `[depth(below), depth(above)+1]`); it commits through the single `moveNode` mutation. The whole gesture lives in `use-drag-reorder.ts` and runs imperatively (DOM, not React state) on the hot path. The dot still zooms on a plain click — a movement threshold tells drag from click, and `consumeClick()` suppresses the zoom after a real drag. Why: [ADR 0010](./docs/adr/0010-drag-to-reorder-and-reparent.md).
- **A moved bullet flashes `bg-card` then fades** (`src/components/flash-node.ts`, `.outline-row.node-acted` keyframe in `styles.css`) as an "acted-upon" signifier. Every move sets `pendingFlash` next to `pendingFocus`, flashed in the same post-render effect: a drag-move, plus all four keyboard moves (`Cmd+Shift+↑/↓` reorder/outdent and Tab/Shift+Tab indent/outdent). `/move`'s **"Go"** crosses a navigation instead: it `requestFlashAfterNav(movedId)` before navigating, and the destination view's mount effect `consumeFlashAfterNav()`s to focus + flash the moved node (a consumed-once module var, not history state, so it fires exactly once). On key-repeat `flashRow` restarts the animation each move (keeps the row tinted while moving, fades once you stop). The fade keeps card's lightness while dropping alpha (`oklch(from var(--card) l c h / 0)`) so it dissolves instead of graying out. Covered by `e2e/move-flash.spec.ts`.

## Zoom + view transitions

Clicking a bullet zooms it to a temporary root (the README's "not built" note is stale). Two rules an agent must not break:

- **The bullet dot zooms (click) and drags (press + move); collapse/expand is the hover chevron** in the left gutter (`OutlineNode`). Don't move zoom onto the collapse control. The dot's click/drag split is owned by `use-drag-reorder.ts` (see ADR 0010).
- **`rootId` is route-owned** (`routes/index.tsx` → `null`, `routes/$nodeId.tsx` → `nodeId`); don't add editor-local zoom state.

How it's URL-driven and how the pivot morph animates: [ADR 0003](./docs/adr/0003-zoom-via-view-transitions.md). That ADR also covers why screenshots can't verify the transition.

## Bookmarks

A bookmark is a **saved zoom view**, stored as `bookmarkedAt: number | null` on the node (not a side table — delete the node and the bookmark goes with it). The header **star** (`BookmarkStar` in `src/components/bookmarks.tsx`) pins the current zoom root; it also owns the trailing divider so it disappears cleanly on home. **Browsing** bookmarks lives in the **node quick-switcher's empty state** (Cmd+K), not the header — the standalone Bookmarks popover was removed once the switcher shipped ([ADR 0013](./docs/adr/0013-bookmarks-browse-folds-into-switcher.md)). **There is deliberately no sidebar** — the unused `ui/sidebar.tsx` is the documented promotion path for when a second nav tenant appears. Adding a new persistent `Node` field needs a localStorage backfill in `collection.ts` (see `migrateAddBookmarkedAt`). Why: [ADR 0011](./docs/adr/0011-bookmarks-via-header-popover.md), [ADR 0013](./docs/adr/0013-bookmarks-browse-folds-into-switcher.md).

## Node quick-switcher (Cmd+K search)

A **Cmd+K** (and the header **magnifier** for touch) opens a fuzzy jump-to over every node's text (Fuse.js), navigating to the picked node's zoom view. It is a *quick-switcher, not a command palette* — v1 runs no actions, only navigation. The whole feature is `src/components/node-switcher.tsx` (self-contained, mirrors `bookmarks.tsx`): `NodeSwitcher` is the `CommandDialog`, mounted **once in `__root.tsx`**; the header `NodeSearchButton` reaches it via the module-level `openNodeSwitcher()`. The Cmd+K listener is **capture-phase** so it fires from inside a contentEditable bullet. cmdk's own filter is **off** (`shouldFilter={false}`) — the list is driven by Fuse. Empty query lists bookmarks; results show breadcrumb context (`buildTrail` in `tree.ts`) and highlight matches. **No new `Node` field, no migration** — recents were deliberately cut. Why: [ADR 0012](./docs/adr/0012-node-quick-switcher.md).

## Tag filtering (`#tag` → prune the subtree)

`#tags` are **parsed from `node.text`**, never a stored field — same mechanism as the inline-`code` chips (`inline-code.ts` shares the tag regex from `src/data/tags.ts`). Each `#tag` renders as a **clickable chip**; a plain click AND-s that tag into a **URL-driven filter** (`?q=#a #b`, typed via `validateOutlineSearch` on both routes) scoped to the current zoom `rootId`. The outline re-renders as a **pruned tree** — matching nodes (own text carries *all* active tags) plus their ancestors as dimmed context (`data-context` on `.outline-row`), everything else hidden. A **tag-pill bar** (`TagFilterBar` in `OutlineEditor.tsx`) shows the active tags; pill ✕ drops one, "Clear"/Escape drops the filter. **Filtering is render-time only — it never mutates `collapsed`** (so clearing restores the exact prior view), and the chip click is delegated on the content container (`onMouseDown` blocks the contentEditable caret, `onClick` filters). v1 is **click-driven, tags-only** — no free-text typing, no `@`-mentions, no autocomplete (all deferred). The pure logic lives in `src/data/tags.ts` (`parseTags`, `parseQuery`, `matchesAllTags`, `buildTagFilter`); the `filter` prop threads into `OutlineNode` (don't reintroduce an index prop — ADR 0014). It coexists with the Cmd+K switcher: that one *jumps away*, this one *narrows in place*.

Two authoring affordances ride along (they don't touch the filter model — the filter is still grown only by clicking chips). **`#` autocomplete** (`useTagMenu` in `tag-menu.tsx`) mirrors `useSlashMenu` (shared caret helpers, now exported from `slash-menu.tsx`) and lists existing tags (`collectAllTags` off the live index); it only opens when there's a match, so new tags are made by finishing typing (no "create" row). `@`-mentions and free text in the bar stay deferred. Why: [ADR 0015](./docs/adr/0015-tag-filtering.md).

## Tag colors (chosen per tag, applied via one stylesheet)

A tag is a neutral `border-border` outline by default; a color is **chosen** per tag name (not derived) and **stored** in its own localStorage TanStack DB collection `tagColorsCollection` (`src/data/tag-colors.ts`, sibling to `nodesCollection`, keyed by normalized name `{ tag, color }`) — so it rides the future sync path and applies to **every instance** of that tag. Color is painted by **one generated stylesheet**, not a per-instance class: every tag surface carries `data-tag`, and `TagColorStyles` (mounted once in `__root.tsx`) emits `[data-tag="x" i][data-tag]{…}` rules from the collection, so recoloring is an O(1) DOM write with **zero React re-renders** (there's no cheap re-decorate-all signal — ADR 0014). The picker (`TagColorMenu`) opens on **right-click** of a chip or filter pill (plain-click is filtering), offering a "no color" clear + a 9-color named palette (`--tag-<name>` light/dark vars in `styles.css`). The generator skips invalid color ids and unsafe tag names (no CSS injection via `data-tag`). Why: [ADR 0016](./docs/adr/0016-custom-tag-colors.md).

## Rich links (`[label](url)` that folds per link)

A link is markdown `[label](url)` **parsed from `node.text`**, never a stored field — the third tenant of the `inline-code.ts` mechanism after code runs and `#tags`. The twist: links are the only construct that **folds** (its rendered length differs from its source), and reveal is **per-link** (Obsidian Live Preview style, ADR 0017 addendum): a link shows RAW (`[label](url)`, decorated — faint `[]()`, link-color url, trailing external-link icon) **only when the caret is within/adjacent to it** (source offset ∈ `[start, end]`, boundaries inclusive); every other link, focused or not, **FOLDS** to a clean `<a class="node-link" data-link contenteditable="false">`. At most one link reveals at a time.

Because a focused bullet can now hold **folded** links, `el.textContent` is no longer the source (a folded link shows only its label), and the caret offset isn't a 1:1 char index. So the core is **source-offset-aware**:
- **`readSource(el)`** (inline-code.ts) reconstructs the markdown from the DOM — `data-src` for each folded `<a>`, `textContent` for everything else (revealed-link spans / code / tags are 1:1). It replaces `el.textContent` in `onInput`/`onCompositionEnd`/paste **and** in the slash/tag menus (else a `/cmd` or `#tag` on a line with a folded link would flatten its url — data loss).
- **`getCaretOffset`/`setCaretOffset`/`getSelectionRange`** return/consume SOURCE offsets, counting a folded `<a>`'s full `data-src-len` (snapping to *after* it if an offset lands "inside" the atomic widget). Enter-split, Backspace, arrow nav, and the menus all keep speaking source offsets, untouched.
- **`inlineMarkupHtml(text, revealOffset: number | null)`** (null = blurred → all fold) and **`decorate(el, text, revealOffset, preserveCaret)`** carry the active-caret offset. `decorate` guards rebuilds against a `WeakMap` render cache (compared against our own generated HTML, not the browser's re-serialized `innerHTML`), so a caret move within the same active link is a no-op.

Why all of this: [ADR 0017](./docs/adr/0017-rich-links.md) (the binding behavior is its **per-link reveal addendum**).

- **Reveal reflow lives in a `selectionchange` watcher** (`watchCaretReveal`), added in `onFocus` and torn down in `onBlur` (OutlineNode + ZoomedTitle) so it's live only while the bullet is focused; it bails on a link-free line and is suspended during IME composition. `onFocus` also reveals the link under the caret, but **deferred to the next animation frame** (`revealLinkAtCaret`) — a synchronous reveal would expand the folded link under the pointer mid-click, so a click at the line's end landed mid-link; deferring lets the click's caret settle against the folded layout first. `onBlur` folds everything (`decorate(el, readSource(el), null, false)`). Both still early-return for `hasLink` so the common (link-free) case is untouched. Links are tokenized **first** so their interior is opaque (a `#tag` inside a label never chips).
- **A folded link opens on click** (new tab), routed through the **same delegated content-container handler** as tag chips in `OutlineEditor` (`mousedown` blocks the caret, `click` does `window.open`). Editing a link is markdown-native: click *beside* it or arrow in → that link reveals raw → edit the text. **No toolbar** (deliberately — bold/italic deferred; see ADR 0017's rejected alternatives).
- **Creating links**: type the markdown by hand, or paste — `pasteIntoBullet` (`src/components/paste-links.ts`) always `preventDefault`s and inserts plain text, with three special cases: selection + bare URL wraps; a single-anchor `text/html` clipboard → `[title](url)`; a bare http(s) URL auto-links. URLs are percent-encoded (`( ) space`) on insert so the simple parser never chokes (`encodeUrlForMarkdown`). v1 is **http(s) only**.
- **Search** (`node-switcher.tsx`) indexes and displays `stripLinks(node.text)` (links → label) so the corpus has no URL noise and Fuse highlight indices line up with the displayed text.

## Environment gotcha: adding a React-importing dependency

If you `bun add` a package that imports React (e.g. `lucide-react`) while `bun run dev` is already running, the app may crash with **"Invalid hook call / multiple copies of React"**. This is a stale Vite dep-optimize cache, not a code bug. Fix: stop the server, `rm -rf node_modules/.vite`, restart. A fresh `bun run dev` and the production build are unaffected.

## Verifying UI changes

The browser preview tool's screenshots **cannot capture view-transition overlays** — they show the settled DOM underneath, so a morph always looks "done" in a screenshot. Verify transitions by instrumenting `document.startViewTransition` and asserting on which element holds `view-transition-name`, not by screenshotting mid-animation.
