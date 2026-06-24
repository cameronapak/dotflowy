# ADR 0019: Daily Notes plugin (one node per day, addressed by a date index)

Status: accepted (2026-06-23), implemented. Design captured via `/grill-with-docs`.
Depends on two new core seams: the **header slot** ([ADR 0020](./0020-header-slot-seam.md))
and **protected nodes** ([ADR 0021](./0021-protected-nodes.md)). Builds on the plugin
architecture ([ADR 0018](./0018-plugin-architecture.md)) and the side-collection pattern
([ADR 0016](./0016-custom-tag-colors.md)).

## Glossary

See `CONTEXT.md` for the canonical definitions. In short: a **daily note** is a node
for one calendar day; the **daily container** is the single protected parent that holds
them; the **daily index** is the `date → nodeId` side-collection that is the *identity*
of a day; the **Today button** is the header control that navigates to (and lazily
creates) today's note.

## Decision

A Daily Notes plugin (`src/plugins/daily/`), one line in `src/plugins/index.ts`. Five
pieces:

1. **Identity is a side-collection, not text and not a `Node` field.** A `dailyIndex`
   collection (localStorage TanStack DB, sibling of `nodesCollection`, mirroring
   `tag-colors.ts`) maps a **local** date `YYYY-MM-DD` → the daily note's `nodeId`. This
   is the source of truth for "which node is 2026-06-23." Unlike `#tags`/links (parsed
   from `node.text`), a day's identity must be **stable and machine-addressable**, so it
   cannot live in mutable text. Unlike `bookmarkedAt`, it is not a `Node` field — Seam E
   keeps plugin data off the `Node` schema. Rides the future sync path like every sibling
   collection.

2. **Structure: one protected container, days as its children.** The plugin lazily
   creates a single **daily container** node and hangs each daily note under it. The
   container is a **protected node** (ADR 0021) so it — and the accumulated day notes plus
   everything written under them — can't be deleted out from under you (`removeNode`
   cascades the whole subtree). Day notes themselves are ordinary children: editable,
   movable, deletable.

3. **Get-or-create, date-generic.** Navigating to a day (the Today button in v1; any day
   in the future week picker) runs one idempotent path: ensure the container exists →
   ensure that date's node exists (create an empty one if the index has no entry, or the
   entry dangles) → zoom to it. Self-healing: a deleted day note is recreated empty on
   next visit; a deleted container is recreated. The button is scoped to *today*; the core
   logic is date-generic from day one so the picker is a pure caller, no retrofit.

4. **A daily note is just a node; the date is *displayed* from the index, not stored as
   identity.** No new `Node` type or field. The note's `text` is **freeform, seeded to the
   full formatted date** ("Tuesday, June 23, 2026") — searchable in Cmd+K and shown as the
   page title when you zoom in — but **not load-bearing** (identity is the index). On top
   of that, a `<Badge>` (`src/components/ui/badge.tsx`) **row slot** (Seam F), driven by an
   `id → date` reverse lookup, shows a **relative** label ("Today" / "Yesterday" /
   "Tomorrow" / else "Jun 23"). The badge is *complementary* to the seeded full-date text,
   not a duplicate: it's the "this is a daily note" signifier plus quick orientation, and
   it's always correct (computed from the mapping, not the editable text). Because the text
   carries the full date, the zoomed-in title reads correctly with no `ZoomedTitle` slot —
   the badge there is a future nicety, not a v1 gap.

5. **Node creation reuses the low-level `mutations.ts` primitives directly.**
   `NodeCommands` (the D8 promoted set) has `onEnter`/`onIndent`/`onDeleteNode`… but no
   "create a node," and its handlers carry editor-edit semantics — a captured undo step and
   a `pendingFocus` — that a get-or-create which then *navigates away* does not want. So the
   plugin composes creation from `appendChild` / `insertChildAtStart` / `setText` (reading
   the index via `ctx.tree`) — the exact primitives `appendChild` documents itself for
   ("seed code owns the wiring"). No promotion onto `ctx.mutations`, no new core surface.

The **Today button** itself is a header slot (ADR 0020): `render(getCtx)` → on click runs
the get-or-create path for today and `ctx.nav.zoom`s to it.

## Why

- **Index over text-parsing.** A day must be addressable as "the node for 2026-06-23." If
  identity were parsed from text (the tag/link approach), editing the heading would change
  or destroy the day's identity. The index is the truth; text is a label.
- **Container over top-level days.** Days as top-level siblings would fill the home view
  with dates and leave nothing cohesive to protect. One container keeps home clean and
  gives protection a single target.
- **Badge from the mapping, not the text.** Text is editable; a badge sourced from text
  could be edited into a lie. The `id → date` lookup can't be — the date shown is always
  the day the node actually *is*.
- **Local date.** SPA-only, no SSR (ADR 0004); the client clock is the user's day
  boundary. No server notion of "today."
- **Promote create, don't import.** Every plugin that reaches past `ctx` into `mutations.ts`
  erodes the D8 seam. Promoting a create primitive keeps the boundary intact and versioned.

## Rejected alternatives

- **A `dailyDate` field on `Node`.** Violates Seam E, needs a `collection.ts` migration,
  and couples the core schema to one plugin's concept. Rejected for the side-collection.
- **Date parsed from `node.text`** (tag/link style). Puts identity in mutable text; one
  careless edit and the day is unaddressable. Rejected.
- **Days as top-level siblings, no container.** Home becomes a date dump; no single thing
  to protect. Rejected for the container.
- **Regenerate-on-demand with no protection.** Cheapest (no protected-node seam), but
  `removeNode` cascades, so an accidental container delete loses written content;
  regeneration only restores *empty* nodes. Rejected — see ADR 0021.
- **Empty text (no seed).** Blank bullets are invisible in Cmd+K. Seeding the formatted
  date is free searchability and a sensible default heading.
- **Promoting a create surface onto `ctx.mutations` / routing through `NodeCommands`** (the
  original design's plan). Rejected once built: `NodeCommands` handlers capture an undo step
  and set `pendingFocus` — editor-edit semantics that are wrong for an infrastructural
  get-or-create that navigates away. The low-level `mutations.ts` primitives (what
  `appendChild` was written for) are the right altitude; no new surface needed.
- **Reusing bookmarks as the day store.** Bookmarks (`bookmarkedAt`) sort by pin time and
  are a different concept (saved zoom view); overloading them muddies both. Separate index.

## Known rough edges

- **No date *badge* in the zoomed-in title.** `ZoomedTitle` renders no row slots, so the
  relative badge shows only on list/picker rows. The zoomed title still reads correctly (its
  text is the seeded full date), so this is a cosmetic nicety, not a gap; a `ZoomedTitle`
  slot seam is the clean way to add it later.
- **Out-of-order days from a future picker.** Each new day inserts at the *top* of the
  container (newest-first for sequential "today" use). A picker that creates an older day
  would still land it on top; the picker will own its own ordering when it ships.
- **Day boundary is the client's local date.** Crossing timezones near midnight can make
  "today" briefly ambiguous. Accepted for v1.
- **Reverse lookup (`id → date`) for the badge** is O(n) over the index unless the daily
  index is also cached by id. Fine at personal scale; revisit if it bites.
- **Week picker, week-start localization** (`weekStartsOn`, since `react-day-picker` in
  `ui/calendar.tsx` already supports it) are future work, not v1.
- **No test runner** (AGENTS.md); `typecheck` is the only static gate. Walk by hand once
  built: click Today (creates container + today's note, zooms in); type notes as children;
  reload (still there); go Home (one "Daily" container, today's note inside with a date
  badge); delete the container (refused); delete today's note, click Today (recreated
  empty).

## What changed

- **`src/plugins/daily/daily-index.ts`** (new) — `dailyIndexCollection` (localStorage
  TanStack DB, `{ key, nodeId }` keyed by `key` = `YYYY-MM-DD` or the `container` sentinel),
  the date helpers (`localDateKey` local-not-UTC, `formatDayText`, relative `formatDayBadge`),
  the non-reactive lookups (`getContainerId` / `getDayId` / `setMapping` / `isContainerNode`),
  and the reactive `useDailyDate` (subscribe pattern mirroring `tag-colors.ts`, prerender-safe).
- **`src/plugins/daily/index.tsx`** (new) — the `PluginDef`: the Today header slot, the
  date-badge row slot, the `protects` predicate, and the get-or-create
  (`ensureContainer` / `ensureDay` / `goToDate`).
- **`src/plugins/index.ts`** — `daily` added to the `plugins` array (one line).
- **`src/plugins/types.ts`** — `HeaderSlotSpec` + `PluginDef.headerSlots` (ADR 0020) and
  `PluginDef.protects` (ADR 0021).
- **`src/plugins/registry.ts`** — composed `headerSlots` and `isProtected`.
- **`src/components/Header.tsx`** — renders header slots (new optional `getCtx` prop).
- **`src/components/OutlineEditor.tsx`** — passes `getCtx={pluginCtx}` to `Header`;
  `onDeleteNode` consults `isProtected` and no-ops on a protected node.
- **`e2e/daily-notes.spec.ts`** (new) — creation+zoom, idempotency, protection.
- **AGENTS.md** — the daily-notes operational pointer.
- **No nodes-schema change, no `collection.ts` migration, no new route.**
