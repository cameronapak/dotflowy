# ADR 0011: Bookmarks via a header popover (no sidebar)

Status: accepted (2026-06-22), implemented

## Glossary

- **Bookmark** — a saved pointer to a node's *zoom view*. Clicking a bookmark does exactly
  what clicking that node's dot does (ADR 0003): navigate to `/$nodeId`. A bookmark is not
  a copy, a saved search, or a saved filter — it is "pin this node so I can jump back to it."
- **`bookmarkedAt`** — the one new field on `Node`: `number | null`. `null` means not
  bookmarked; a timestamp means bookmarked *and* records when, which is also the rail's sort
  key. Replaces what would otherwise be a `bookmarked: boolean`. See *Why a timestamp, not a
  boolean*.
- **Current view / zoom root** — the node named by `rootId` (route-owned: `null` on `/`,
  `nodeId` on `/$nodeId`, per ADR 0003). The header **star** toggles the bookmark on *this*
  node.
- **Star toggle** — a button in the app-shell header that bookmarks/unbookmarks the current
  view. Filled when the current view is bookmarked, outline when not. Hidden (or disabled)
  on home, where there is no single node to pin.
- **Bookmarks popover** — a transient panel opened from a header **Bookmarks** button,
  listing saved nodes newest-first. The whole bookmark *surface*; there is no sidebar.
- **Promotion trigger** — the named future condition under which the popover becomes a
  sidebar: a *second* real tenant (search, settings, etc.) needing persistent nav chrome.
  Until then, one tenant does not earn a sidebar. See *Rejected alternatives*.

## Decision

Bookmarks are stored as a nullable timestamp on the node, toggled by a **star in the header**
that pins the **current zoom view**, and browsed through a **popover** opened from a header
**Bookmarks** button. **There is no sidebar.**

### Why a timestamp, not a boolean

A `bookmarked: boolean` carries no order, which forces the rail to sort by some *other*
field, and every candidate is wrong:

- `updatedAt` — editing a bookmarked node's text would yank it to the top of the rail. The
  rail would reorder itself as you type. Unacceptable.
- `createdAt` — when the node was *created* has nothing to do with when you *pinned* it.

`bookmarkedAt: number | null` answers both questions with one field — *is it bookmarked?*
(`!== null`) and *in what order?* (the timestamp). It strictly dominates the boolean, so the
boolean is not worth having.

This is a nullable field, **not a zod `.default()`** — ADR 0005 is untouched. `makeNode()`
sets `bookmarkedAt: null` at construction like every other field.

### What "bookmark the current view" means

The toggle lives in the **app-shell header**, which is global, so it acts on the one node the
header is *about*: the zoom root. To bookmark an arbitrary node you zoom into it first (one
click on its dot), then hit the star — the browser model, where the address-bar star pins the
page you are on.

"Any node is bookmarkable" still holds: any node can be zoomed, so any node can be starred.
And because the data model is just a field on the node, an **inline per-node bookmark
affordance can be added later with zero model change** — it would set the same field. The
header star is the v1 affordance, not the only possible one.

### Two header controls, each doing one thing

| Control | Job | Visible when |
| ------- | --- | ------------ |
| **Star toggle** | Bookmark / unbookmark the current view | Zoomed (`rootId !== null`) |
| **Bookmarks** button | Open the popover listing all bookmarks | Always |

Browser-proven split: the star is a one-click toggle for *here*; the Bookmarks button is the
*list*. Folding both into a single control (a popover with "Bookmark this view" at the top)
was considered and rejected as slower for the common toggle.

In the header these two controls land in **different visual groups**, divided by a vertical
separator: the star sits in the **focused-node group** (it acts on the single node in view),
while the Bookmarks list joins the **global group** (show-completed, theme) because it is
app-wide. The star **owns the divider** — both appear and disappear together, so on home
(no node in view) the cluster collapses to just the global group with no dangling separator.

### Invariants (the truth table)

| Situation | Behavior |
| --------- | -------- |
| On home (`rootId === null`) | **No star** — nothing single to pin. Bookmarks button still opens the (possibly empty) list |
| Current view already bookmarked | Star renders **filled**; pressing it **removes** the bookmark |
| A bookmarked node is **deleted** | Bookmark **disappears with it** — it was a field on that node; no dangling entry, no cleanup pass |
| A bookmarked node's **text is empty** | Rail row shows **"Untitled"**; order unaffected |
| A bookmarked node's text **changes** | Rail label updates live (derived from the tree); **rail order does not move** (sorted by `bookmarkedAt`, not `updatedAt`) |
| Click a bookmark | **Navigate to `/$nodeId`** — identical to zooming that node; plain route nav |
| Zero bookmarks | Popover shows an **empty state** explaining how to bookmark |

### Label, order, click

- **Label** = the live `node.text`, rendered **plain and single-line truncated** (the rail is
  navigation, not content — no inline-code chips, no wrapping). "Untitled" when empty.
- **Order** = `bookmarkedAt` **descending** (most recently pinned on top). Manual reorder is
  explicitly out of scope for v1 (see *Known rough edges*).
- **Click** = navigate to `/$nodeId`. No forced zoom **morph** (ADR 0003): the morph animates
  a pivot dot into the title, and a popover row is not that dot. A plain navigation is honest
  here.

## Why

- **The grill killed the sidebar on purpose.** The request started as "add a sidebar," but
  the only tenant is bookmarks, and the stated need is "only needed when you need them" —
  ephemeral, summon-and-dismiss. That is a popover. A sidebar is *permanent chrome* on an app
  whose whole identity is a centered 720px text column; it would fight the design to hold one
  occasional list.
- **A popover is nearly free; a sidebar is not.** The sidebar's cost isn't the component
  (shadcn's `ui/sidebar.tsx` already ships unused in the repo) — it's the **layout surgery**:
  a sidebar must wrap `<Outlet/>` in `__root.tsx`, and the `Header` currently lives *inside*
  `OutlineEditor` (it owns the breadcrumb). A popover hangs off a header button and touches
  none of that.
- **Bookmark = saved zoom view reuses everything.** No new navigation concept, no new route,
  no new render path. A bookmark is a stored `nodeId`; clicking it is the zoom that already
  exists.
- **The field-on-node model erases the hard parts.** Dangling references (the classic bug of
  a separate bookmark list) cannot occur — delete the node, the bookmark is gone. No
  reconciliation, no orphan sweep.

## Rejected alternatives

- **A collapsible sidebar, hidden by default (shadcn `ui/sidebar.tsx`).** The closest
  contender: off-canvas, Cmd+B, mobile sheet, can pin open beside the outline. Rejected for
  **now** — it still requires the `__root.tsx` / `Header` layout restructure, and pinning a
  bookmark list open beside the column is a want nobody has expressed. Held behind the
  **promotion trigger**: when a *second* real nav tenant appears, promote the popover to this
  sidebar. The component staying in the repo is fine; it is the documented next step, not dead
  code to delete.
- **`bookmarked: boolean` on the node.** Rejected: no sort order, forcing a wrong sort field
  (`updatedAt` reorders on edit, `createdAt` is unrelated to pinning). The timestamp gives the
  boolean for free (`!== null`) plus the order.
- **A separate bookmarks collection / localStorage id-list.** Its only advantage is manual
  bookmark ordering. Rejected for v1: it adds a second persistence path and reintroduces
  dangling references on delete. If manual ordering is ever wanted, add a `prevBookmarkId`
  pointer on the node (same linked-list trick as `prevSiblingId`) rather than a side table.
- **Per-node bookmark item in the `MoreHorizontal` menu as the v1 affordance.** Rejected as
  the *primary* control in favor of the header star (the browser model the user chose). Not
  rejected forever — the field-on-node model makes adding it later a pure UI change.
- **One combined "Bookmarks" control** (popover with "Bookmark this view" at the top).
  Rejected: makes the common one-click toggle a two-step open-then-click.

## Known rough edges

- **No manual reorder in v1.** Order is recency only. If the rail grows long, "I want my most
  important bookmark first" has no answer yet. The `prevBookmarkId` migration above is the
  planned path; not built.
- **Bookmarking a deep node is two steps** (zoom, then star) by design. If that friction bites
  in practice, the inline per-node affordance is the additive fix — model already supports it.
- **No test runner** (AGENTS.md). `typecheck` is the only static gate. Walk by hand: star on a
  zoomed node, star hidden on home, unbookmark, delete a bookmarked node (rail row vanishes),
  empty-text bookmark shows "Untitled", edit a bookmarked node's text (label updates, order
  holds), click a bookmark (navigates/zooms), empty-state popover.

## What changed

- **`src/data/schema.ts`** — added `bookmarkedAt: z.number().nullable()` to `nodeSchema`.
- **`src/data/tree.ts`** — `makeNode()` sets `bookmarkedAt: null`.
- **`src/data/collection.ts`** — `migrateAddBookmarkedAt()`, a one-time backfill mirroring
  `migrateAddIsTask`: patches missing `bookmarkedAt` to `null` in the raw localStorage payload
  before the default-less schema validates it on load. Without it, every pre-existing user's
  data would fail validation the moment the field was added.
- **`src/data/mutations.ts`** — `toggleBookmark(nodeId, bookmarked)`: sets `bookmarkedAt` to a
  timestamp or `null` via the shared `update()` (so it bumps `updatedAt` and persists like any
  mutation).
- **`src/components/bookmarks.tsx`** (new) — two **self-contained** components, one per header
  group (a cleaner split than the "Header + editor" sketch this ADR originally proposed; the
  Header stays a dumb shell with no `rootId`/handler threading):
  - **`BookmarkStar`** (focused-node group) — reads `rootId` from the route
    (`useParams({ strict: false }).nodeId`) and the node from `useTree()`. Renders the star
    (filled when bookmarked, `capture` + `toggleBookmark` on click) **plus its trailing
    vertical divider**, or `null` on home — so the divider never dangles.
  - **`BookmarksMenu`** (global group) — reads the collection directly via `useLiveQuery`
    (a flat filter + sort; no tree index needed), renders the popover: rows are
    `<Link to="/$nodeId">` with live truncated text / "Untitled"; empty state otherwise.
- **`src/components/Header.tsx`** — right cluster is now `BookmarkStar` (+ its divider) ·
  `BookmarksMenu` · `ShowCompletedToggle` · `ModeToggle`: focused-node action, divider, then
  the global group.
- **No `__root.tsx` change, no sidebar wiring.** `ui/sidebar.tsx` stays unused as the documented
  promotion path.
- **Undo** is shared: the toggle's `capture` pushes to the same module-level stack the editor's
  Cmd+Z reads, so one bookmark toggle = one undo step.
