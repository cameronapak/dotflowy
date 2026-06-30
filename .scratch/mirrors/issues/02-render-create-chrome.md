# 02 — Render + create + chrome (delivers the use case)

Status: ready-for-human

Stage 1 of [PRD](../PRD.md) / [ADR 0022](../../../docs/adr/0022-node-mirrors.md). The meat of the feature
that isn't the caret surgery. After this, a task mirrored into Today is **visible, expandable, text-synced,
and checkable in both places** — the motivating use case. Behind a flag.

## Scope

**Render walk (`visible-order.ts` + `tree-store.ts`):**
- Resolve `contentId = mirrorOf ?? id` per node; recurse over the **content's** children so a mirror windows
  its source's subtree.
- Hybrid path addressing: emit bare `nodeId` keys until a mirror is crossed, compound path keys inside a
  mirrored subtree. One walk definition still shared with caret nav.
- Mirror top row reads `useNode(contentId)` for text/`completed`/`isTask` (the field split).
- Cycle guard: render-time truncation to a non-expandable **capped row** (chevron off, badge, click → source)
  when a mirror's source is already an ancestor on the path. Broken-mirror render when `contentId` is missing.

**Create (reuse the Move destination picker):**
- `/mirror` "Mirror to…" command (Seam C); selection-menu `runMany` for multi-subtree mirror
  ([ADR 0018](../../../docs/adr/0018-node-multi-selection.md)).
- daily plugin: "Mirror to Today" (no picker, target = today's note) **alongside** the existing
  "Move to Today".
- Create-time cycle block (refuse mirroring into own subtree/self — shake + toast).
- Flatten mirror-of-mirror to the true source on create.
- Each create is one `runStructural` batch ([ADR 0009](../../../docs/adr/0009-atomic-structural-writes.md)).

**Chrome (core, both row + zoomed-title paths):**
- Always-on mirror icon + tint on instances; "mirrored ×N" badge on the source (from the reverse index).
- Hover / `:focus-within` colored border, source hue vs instance hue — **pure CSS keyed off `data-mirror`**,
  zero JS (tag-color ethos, [ADR 0007](../../../docs/adr/0007-custom-tag-colors.md)).
- Badge → "appears in N places" jump list (reuse node-switcher/move-dialog list).
- Cmd+K dedups instances to the source.

## Acceptance

- [ ] Mirror a project task into Today; both show the same text; editing text in one updates the other.
- [ ] Toggle `completed` from either instance → both reflect it.
- [ ] Expand the mirror → its source's children render under it (read/scroll fine; full *editing* parity is
      Stage 3 — note any rough caret edges).
- [ ] Cycle: mirror-into-own-subtree blocked at create; a cycle formed by a later move renders a capped row,
      never hangs.
- [ ] Badge count correct; jump list navigates to each instance; hover borders show source vs instance.
- [ ] Flag off → outline byte-identical to today (no path keys, no perf change). e2e parity green.

## Out of scope (later stages)

Restructuring a mirror's subtree with correct focus/caret/drag (Stage 2); promote-on-delete (Stage 3).
