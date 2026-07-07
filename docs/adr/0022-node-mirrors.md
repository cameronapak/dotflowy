---
status: proposed
---

# Node mirrors (synced instances)

**What.** A **mirror** is a node that, instead of owning its own text and children, *windows* another
node's — the **source**. Every place a node appears is an **instance**; editing any instance edits the
underlying content, so all instances update (WorkFlowy mirrors / Notion synced blocks). The motivating
case: a task that lives under its **project** *and* under **Today**, fully editable in both, so it's
never lost when reviewing either. Designed via `/grill-with-docs`; build plan + staging belong in
`.scratch/mirrors/PRD.md`. Will ship **behind a flag**, like [ADR 0019](./0019-virtualized-outline-rendering.md).

**The constraint this fights.** dotflowy identifies every rendered row by a single `nodeId` — not just
`VisibleRow.id`, but the `refs` map (id→span), `pendingFocus`/`pendingFlash`, caret nav, React keys, and
the per-node subscriptions ([ADR 0004](./0004-localized-rendering-via-the-tree-store.md)). The whole
model assumes **one node = one row**. A mirror breaks that by definition. So the real cost of mirrors is
**not** the `mirrorOf` column — it's that **row identity must become a render *path*, not a node id**.

## Decisions

**Inline-expandable, not a reference (chose A1 over A2).** A mirror renders the source's full subtree
inline — expand, edit, and restructure its children right where it sits. The cheaper alternative (a
reference that shows the text and opens the subtree on click) was rejected: it dodges path identity but
isn't the synced-block experience. A1 is the destination; the build *stages* toward it (below) so A2-grade
value lands first.

**Pointer model, not a content-entity.** A mirror is a normal node with a new `mirrorOf: string | null`
pointer; a non-mirror node has `mirrorOf === null` and **is its own source**. Children still hang off the
source node's id (`parentId`), exactly as today. Rejected alternative: give every node a shared `contentId`
and hang children off *that* (truly symmetric instances, trivial delete). It's the "cleaner" Notion model
but rewrites `buildTreeIndex`, every mutation, and the wire schema — far more invasive for a feature that's
rare per outline. The pointer model keeps the mirror-free outline untouched.

**Resolution: `contentId = mirrorOf ?? id`, recurse over the content's children.** The render walk, at each
node `N`, reads content from `contentId` and recurses into `contentId`'s children (so a mirror windows the
source's subtree). The **only** place content ≠ position is a mirror's own boundary — everything *inside* a
mirrored subtree is real nodes (a child `c1` of source `A` has `parentId === A`; it's not itself a mirror
unless it carries its own `mirrorOf`).

**Hybrid path addressing (the keystone).** A row's **data** is read by id (`useNode(contentId)`) so text/
completed/children sync everywhere for free. A row's **address** — React key, `refs`, `pendingFocus`/
`pendingFlash`, selection, drag — becomes the **render path** (the chain of ids from the view root). But a
row keeps its **bare `nodeId`** address while *no mirror is on its path* (byte-identical to today), and only
switches to a compound path key **once the walk has crossed a mirror**. All the new complexity is fenced
inside mirrored subtrees; the 99% mirror-free outline runs today's exact code. Zoom is unaffected —
`rootId` is always a real node id (zooming a mirror `M` resolves to showing `A`'s content).

**Field split — what syncs vs. what's local.**
- **Content (read from the source, syncs across instances):** `text`, `isTask`, `completed`, children.
  Checking the task off in Today checks it in the project — same task, same done-state.
- **Local (read from the instance node where it sits):** `parentId`/`prevSiblingId` (position), `collapsed`,
  `bookmarkedAt`. A mirror can be collapsed in Today while expanded in the project; bookmarking the Today
  view vs. the project view are different saved views (different ids → different URLs).
- **Divergence from WorkFlowy, accepted for v1: descendant collapse is *shared*, not per-instance.** A
  mirror's own top collapses independently (free — it's the instance node's field), but collapsing a
  *sub-item* collapses it everywhere, because that sub-item is the same underlying node. Fully per-instance
  descendant collapse needs a `path → collapsed` override store — real cost for marginal gain.

**Delete = promote, cascade-aware.** Deleting a mirror is trivial (one node; its "children" are the
source's, untouched). Deleting the **source** while instances survive **promotes**: pick the oldest
surviving instance, clear its `mirrorOf`, reparent the real children under it, repoint the other mirrors at
it — one atomic batch ([ADR 0009](./0009-atomic-structural-writes.md)), undoable. This makes the source/
instance distinction *invisible* (Notion's "content survives in the remaining copies"). Critically, promote
runs on **any** removal, including a cascade delete of an ancestor subtree: if you delete a whole project
and a mirror of one of its tasks lives in Today *outside* the deleted subtree, the content promotes into
Today rather than vanishing. **Content dies only when the last instance is gone.** Rejected: *block*
deletion of a mirrored source (user-hostile when it fires) and *cascade* (deleting the source silently
nukes every mirror — surprising).

**Cycle guard, two layers.** A mirror windows its source's children, so a mirror of `A` placed inside `A`'s
own subtree (directly, or via a later move, or a chain) would render forever. (1) **At creation**, block the
obvious case — refuse to mirror a node into its own subtree or itself (shake + toast). (2) **At render**,
the walk tracks the source ids on the current path and refuses to expand a mirror whose source is already an
ancestor; that mirror renders as a **non-expandable capped row** (chevron disabled, mirror badge, click
jumps to source) — the safety net for cycles formed *after* creation, which the create check can't catch.
Show the capped row, don't hide it.

**Creation reuses the Move destination picker.** Mirror is Move's sibling — Move *relocates*, Mirror *leaves
the node and drops an instance at the target*. Entry points: a `/mirror` "Mirror to…" command (Seam C), the
selection actions menu via `runMany` (mirror several subtrees at once, [ADR 0018](./0018-node-multi-selection.md)),
and daily's **"Mirror to Today"** (no picker, target = today's note). Daily keeps **both** "Move to Today"
(the current move) and "Mirror to Today" — relocating and "this also matters today" are different intents.

**Visual — legible, low-noise (core chrome, both render paths).** Mirrors are a core concept (they rewrite
the render walk), not a plugin seam, so the chrome renders in both the list row and the zoomed title (the
dual-path rule). Always-on: a mirror icon + subtle tint on instances, a "mirrored ×N" count badge on the
source. On **hover / caret-inside** (`:focus-within`): a colored border — one hue for the source, another
for instances (Notion's red/blue, revealed only when you're working in it) — **pure CSS keyed off a
`data-mirror` attribute, zero JS / zero re-render**, same ethos as the tag-color stylesheet
([ADR 0007](./0007-custom-tag-colors.md)). Clicking a badge opens an **"appears in N places" list**
(breadcrumb per instance, click to jump), reusing the node-switcher/move-dialog list and the reverse index.

## Defensive measures

- **Flatten mirror-of-mirror.** Mirroring a mirror sets `mirrorOf` to the *true source*, never to another
  mirror — keeps promote and cycle detection from walking chains.
- **Broken-mirror render.** If `mirrorOf` ever points at a missing node (sync race / bug), the mirror renders
  a "source not found" leaf, never throws.
- **Reverse index** (`sourceId → instance ids`) maintained in the tree-store like `childrenByParent` — powers
  the count badge and the promote lookup without an O(n) scan per delete.
- **Orphan rescue at snapshot load** (`healMirrorOrphans`, `collection.ts`, the `healSiblingChains` sibling).
  Any node whose `parentId` points at a mirror **instance** (`parent.mirrorOf != null`) is by definition
  orphaned — a mirror windows its source's children, so the instance-parented node is never rendered. This is
  the data left behind by the pre-fix keyboard-indent bug (mirrors ship default-ON, so real outlines have it).
  The heal repoints each such node at the true source, appended after the source's real children, and persists
  it. **Gated on `isMirrorsEnabled()`**: with the flag OFF a `mirrorOf` node renders its own children, so that
  child is legitimately placed and must NOT be moved. Early-returns on any flag-off / mirror-free outline.
- **Single-DO safety.** Source and all instances live in the same per-user Durable Object
  ([ADR 0008](./0008-sync-via-a-per-user-durable-object.md)); a mirror is always intra-DO, so there's no
  cross-boundary consistency problem. (Cross-user mirrors would be a different decision — out of scope.)
- **Search dedups, export expands.** Cmd+K dedups instances to the source (one result; the instance list
  handles "go to the other one"). Markdown export ([ADR 0017](./0017-markdown-export.md)) expands a mirror to
  its content — there's no markdown for "mirror."

## Schema + wire

Add `mirrorOf: string | null` to `nodeSchema` ([ADR 0003](./0003-no-schema-defaults.md): required + nullable,
no default; `makeNode` sets `null`). `worker/wire.ts` gains the field and the Worker's derived types follow
([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)); the DO's `nodes` table gains the column.
Existing rows backfill `null` at snapshot load in `collection.ts` (the `healSiblingChains` pattern). Additive
and nullable — low-risk.

## Staged build (the expensive 20% lands last)

Even though we chose A1, the build is sequenced so daily value arrives before the caret-sensitive surgery:

- **Stage 0 — plumbing, ships dark.** `mirrorOf` through schema/`makeNode`/wire/DO/backfill; reverse index. No
  behavior.
- **Stage 1 — render + create + chrome (≈ A2-grade value).** Mirror-aware walk (contentId resolution, source
  windowing, path keys inside mirrors), cycle guard + capped row, broken-mirror render; "Mirror to…" / "Mirror
  to Today"; visual badges + hover borders + instance list. Text and `completed` already sync (data by id), and
  you can *see and check* the whole subtree in both places. **This delivers the motivating use case.**
- **Stage 2 — full editing parity inside mirrors (the A1 gold-plate).** Path-based `focus`/`pendingFocus`/
  `flash`/drag/multi-select inside mirrored subtrees, and structural mutations redirecting at the mirror
  boundary (insert a child under a mirror → under the source). The caret-sensitive, regression-prone part;
  heavy e2e.
  - **Boundary redirect covers EVERY structural entry point, not just drag.** The first cut resolved the
    mirror boundary only in the drag `onMove` handler; keyboard **indent** (`Tab`), the **edge reparent**
    (`Cmd+Shift+↑/↓` nudging into an uncle/aunt), and **multi-select `Tab`** (`indentManyNodes`) each derive
    their new parent *inside* the mutation primitive, so a mirror prev-sibling/uncle sent the node under the
    **instance** id — whose row windows the *source's* children and never the node, so it **vanished**. Fixed
    by resolving `trueSourceOf` at each derivation site (`indent`, `reparentIntoParent{Prev,Next}Sibling`,
    `indentManyNodes`). The flag is passed **as a `resolveMirror` param**, never a `flags.ts` read — `mutations.ts`
    stays pure and OFF runs byte-identical old code (matching the drag call site, which gates on
    `isMirrorsEnabled()`). Collapse-expand still targets the visible **instance** (a local field). `outdent` is
    unaffected — its target is a grandparent, always a real content node. e2e: `mirror-editing.spec.ts`.
- **Stage 3 — promote-on-delete** (direct + cascade-aware) and its undo/redo.

## Don't regress

- The mirror-free outline must run **today's exact code** — bare `nodeId` addressing until a mirror is crossed.
  Don't make every row pay for path identity.
- Keep node data flowing through the per-node subscriptions ([ADR 0004](./0004-localized-rendering-via-the-tree-store.md));
  mirrors change a row's *address*, not how it gets its data. Don't thread mirror state as props.
- Every mirror mutation (create, promote) is **one `runStructural` batch** ([ADR 0009](./0009-atomic-structural-writes.md)).
- One render-walk definition (`visible-order.ts`) still drives both render and caret nav — don't fork a
  mirror-aware copy that drifts from the neighbor walk.
