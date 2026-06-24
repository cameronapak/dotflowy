# ADR 0020: Header slot seam (node-less plugin chrome)

Status: accepted (2026-06-23), implemented. Extends the plugin architecture
([ADR 0018](./0018-plugin-architecture.md)); first consumer is the Daily Notes plugin's
Today button ([ADR 0019](./0019-daily-notes-plugin.md)).

## Glossary

- **Header slot** — a node-less plugin render slot in the app header (the right cluster of
  `Header.tsx`).
- **`HeaderSlotSpec`** — its contract: `render(getCtx)` (no node), distinct from the
  node-scoped row-slot `SlotSpec` (`render(node, getCtx)`).

## Decision

Add a **header slot** seam so a plugin can place a control in the app header. Because
header chrome has **no focused node**, it is a **separate `HeaderSlotSpec` with
`render(getCtx)`** — not an overload of the existing `SlotSpec`. The core renders all
registered header slots into `Header`'s right cluster (in plugin/array order, alongside
the core actions). No new context shape is needed: `PluginContext` is *already* node-less
(`{ tree, mutations, nav, search, openOverlay }`), and `OutlineEditor` — which builds
`pluginCtx` and renders `Header` on every route, home included — threads `getCtx` straight
down.

## Why

- **Separate spec over overloading `SlotSpec`.** Row slots are *node decoration*
  (`render(node, getCtx)`); header slots are *app chrome* (`render(getCtx)`). Making `node`
  optional to serve one consumer would muddy every row slot's type. Two small, honest specs
  beat one ambiguous one.
- **The original objection dissolved on inspection.** The first worry was "a header button
  needs a different context shape because it has no node." It doesn't: the node was never in
  `PluginContext` — it's passed separately to handlers. So the seam is just a new slot
  region plus a node-less render signature. Cheap.
- **Reuse `pluginCtx` where it already lives.** It's built in `OutlineEditor`, which renders
  `Header`. No new plumbing, no module-level singletons.

## Rejected alternatives

- **Overload `SlotSpec` (make `node` optional).** Pollutes the common, node-scoped case for
  one node-less consumer. Rejected.
- **Hardcode the button in `Header.tsx` + a module-level `goToToday()`** (the
  `openNodeSwitcher()` / `NodeSearchButton` pattern). Pragmatic, zero seam — but the core
  then carries feature knowledge of daily notes, the exact anti-goal of ADR 0018. This is
  the documented **reversible fallback** if the seam ever feels like overkill, mirroring the
  `ui/sidebar.tsx` "promote when a second tenant appears" stance — except here we chose to
  build the seam now, since the Today button can't be expressed any other way without core
  coupling.
- **A full global-command / action registry.** Overkill for placing controls in the header;
  the `/` palette (Seam C) already covers node-scoped commands.

## Known rough edges

- **Only the header right-cluster is a slot.** No left/center header regions until something
  needs them (`SlotPosition` grows lazily, like everything else).
- **Ordering vs the core actions**: as built, plugin header slots render *first* in the
  right cluster (leftmost), ahead of the bookmark star / search / show-completed / theme.
- **No `ZoomedTitle` slot** is implied by this ADR; that's a separate extension flagged in
  ADR 0019 for the date badge.
