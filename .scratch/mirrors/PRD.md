# PRD: Node mirrors (synced instances)

Status: **Designed, not scheduled.** Full grill complete; design locked in
[ADR 0022](../../docs/adr/0022-node-mirrors.md) (`proposed`) and glossary in
[`CONTEXT.md`](../../CONTEXT.md). Build is gated on a priority decision (this is the biggest editor
change since virtualization — see *Cost* below). No code yet.

## Why

A task often belongs in two places at once — under its **project** *and* under **Today** — and today's
"Send to Today" *moves* it, so it leaves the project. The user wants it to live in **both**, fully
editable from either, so it's never lost when reviewing the day or the project. That's a true **mirror**
(WorkFlowy mirror / Notion synced block): a node that *windows* another node's content + children, so
editing any instance edits the one underlying node.

## Locked design (from the grill)

- **True mirror, inline-expandable (A1)** — not a click-to-open reference (A2), not a scheduled-date
  agenda view (B). The synced-block experience, expandable and editable in place.
- **Pointer model** — a new `mirrorOf: string | null` on the node; a non-mirror node is its own source
  (`mirrorOf === null`). *Not* a shared `contentId` entity (too invasive). Children still hang off the
  source's id.
- **Resolution `contentId = mirrorOf ?? id`**, recurse over the content's children. Content ≠ position
  only at a mirror's own boundary.
- **Hybrid path addressing (keystone)** — data read by id (sync is free); the row *address* (key/`refs`/
  `pendingFocus`/`pendingFlash`/selection/drag) becomes the render path, but switches to a compound key
  **only once a mirror is crossed**. The mirror-free outline runs today's exact code.
- **Field split** — content (`text`, `isTask`, `completed`, children) syncs from the source; local
  (`parentId`/`prevSiblingId`, `collapsed`, `bookmarkedAt`) per instance. **Descendant collapse is shared
  in v1** (accepted divergence from WorkFlowy).
- **Delete = promote, cascade-aware** — deleting the source promotes a surviving instance; content dies
  only when the last instance is gone. One atomic batch, undoable.
- **Cycle guard, two layers** — block mirroring into your own subtree at create; truncate to a
  non-expandable capped row at render.
- **Creation reuses the Move destination picker** — `/mirror` "Mirror to…", selection-menu `runMany`,
  daily "Mirror to Today" (keep "Move to Today" too).
- **Visual (core chrome, both render paths)** — always-on icon + tint on instances, "mirrored ×N" badge on
  source; hover/`:focus-within` colored border (source hue vs instance hue), pure CSS; badge → "appears in
  N places" jump list.

Full rationale + rejected alternatives: [ADR 0022](../../docs/adr/0022-node-mirrors.md).

## Cost (why this is gated)

[ADR 0004](../../docs/adr/0004-localized-rendering-via-the-tree-store.md) and
[ADR 0019](../../docs/adr/0019-virtualized-outline-rendering.md) are built on **one node = one row**.
Mirrors break that invariant. Stages 0/1/3 are tractable; **Stage 2 (path-based focus/caret/drag inside
mirrors) is the most regression-prone code in the app** and where the weeks go. The staging below is
deliberate: **Stage 1 alone delivers the motivating use case** (task visible + checkable in both places,
text/completed synced, subtree expandable). Stage 2 is the "restructure subtasks from inside Today"
gold-plate.

## Scope (staged; ships behind a flag like `isVirtualized()`)

**Stage 0 — plumbing, ships dark.** [`issues/01`](./issues/01-mirror-of-plumbing.md)
- `mirrorOf` through `schema.ts` / `makeNode` / `worker/wire.ts` / DO `nodes` table; backfill `null` at
  snapshot load (`collection.ts` heal pattern); reverse index (`sourceId → instance ids`) in `tree-store`.
- No behavior change.

**Stage 1 — render + create + chrome (≈ A2-grade value).** [`issues/02`](./issues/02-render-create-chrome.md)
- Mirror-aware walk (contentId resolution, source windowing, path keys inside mirrors); cycle guard +
  capped row; broken-mirror render.
- "Mirror to…" / "Mirror to Today" creation; visual badges + hover borders + instance list.
- Text + `completed` sync (free, data by id); subtree expandable/viewable in both places. **Delivers the
  use case.**

**Stage 2 — full editing parity inside mirrors (A1 gold-plate).** [`issues/03`](./issues/03-editing-parity.md)
- Path-based focus/`pendingFocus`/flash/drag/multi-select inside mirrored subtrees; structural mutations
  redirecting at the mirror boundary. Heavy e2e. The hard part.

**Stage 3 — promote-on-delete.** [`issues/04`](./issues/04-promote-on-delete.md)
- Source delete (direct + cascade-aware) promotes a surviving instance; undo/redo of promote.

## Gotchas to watch (anticipated — confirm as built)

- **Mirror top row subscribes to `useNode(contentId)`, not the position id** — else its text/completed
  won't track the source.
- **`structureRev` must invalidate views showing a mirror when the *source* subtree changes.** It bumps on
  any structural edit (global), so this should fall out — verify with a mirror-of-edited-subtree e2e.
- **Drag/reorder inside a mirror moves the *real* node** (reorders under the source too). Correct, but
  surprising — cover it in e2e and document.
- **`flatten mirror-of-mirror` at create** (point at the true source) — or promote/cycle detection walks
  chains.
