# ADR 0022: Search provider seam (aliases + virtual actions in the pickers)

Status: accepted (2026-06-23), implemented. Extends the plugin architecture
([ADR 0018](./0018-plugin-architecture.md)) with a new seam (J). Its first consumer is the
Daily Notes plugin ([ADR 0019](./0019-daily-notes-plugin.md)): making "today" findable in
Cmd+K. **Extends the navigation-only quick-switcher of [ADR 0012](./0012-node-quick-switcher.md)**
— the switcher now also runs plugin-supplied *actions*, not only navigation.

## Glossary

- **Search alias** — an extra fuzzy-match term a plugin contributes for a *real* node it
  recognizes (the daily plugin maps a day note to "Today"/"Yesterday"), so the node is
  findable by a label that isn't in its text. Matched, **never highlighted**.
- **Virtual search action** — a *non-node* row a plugin contributes to the Cmd+K switcher,
  built from the live query, that **runs an action** on pick (daily's create-today-if-absent).
- **`SearchActionContext`** — the minimal surface a virtual action gets: `{ index, goTo }`.
  Deliberately *not* a full `PluginContext` (the switcher has none).

## Decision

A **search provider seam (J)** with two independent halves a plugin can contribute:

1. **`searchAliases(node): string[]`** — pure projection, no ctx. The two Fuse-driven
   pickers (`node-switcher.tsx`, `move-dialog.tsx`) add `aliases` as a **second Fuse key**.
   Because highlight only reads the `text` key (`textMatchIndices`), an alias match ranks /
   finds the node but renders no `<mark>` — so the row still displays `node.text` and there
   are **no misaligned ranges** (the same hazard ADR 0017 fixed for links, avoided by
   keying the alias separately instead of concatenating into `text`).

2. **`searchActions(query, ctx): SearchAction[]`** — virtual rows for the **switcher only**
   (v1), built from the live query, each with a `run()` that creates/resolves a node then
   navigates. `ctx` is the minimal `{ index, goTo(nodeId) }` — enough for get-or-create plus
   a plain navigate, so the `__root.tsx`-mounted switcher needs **no `PluginContext`** and
   plugins **import no router types**.

Both are composed in `registry.ts` (`searchAliases` / `searchActions`) like every other
seam. **daily** contributes: aliases = the relative label for its mapped node; one virtual
"Go to Today" action that appears **only when today's note doesn't exist** (when it does, the
alias surfaces the real node — no duplicate row). Its `run` reuses `getOrCreateDay`, which
was refactored to take a `TreeIndex` (not a `PluginContext`) precisely so the switcher, the
Today button, and the `/` command all share one get-or-create.

## Why

- **Alias over rewriting `node.text`.** "Today" drifts at local midnight; baking it into text
  would need a daily rewrite and would lie once edited. The alias is computed from the
  `id → date` mapping at index time — always correct, never stored. (Same reason the badge
  is computed, ADR 0019.)
- **Separate Fuse key over enriching `text`.** Enriching `text` misaligns highlight indices
  against the displayed title. A distinct, non-highlighted key keeps display = `node.text`.
- **Minimal `{ index, goTo }` over a full `PluginContext`.** The switcher lives in
  `__root.tsx`, outside `OutlineEditor` (where `pluginCtx` is built). Threading a real
  `PluginContext` up there is heavy plumbing for a row that only needs to create + navigate.
  A two-field context keeps the seam cheap and the dependency direction clean.
- **Virtual actions are the only way to surface a node that doesn't exist yet.** You can't
  pick a row that isn't there; "search today even before it's created" *requires* a synthetic
  row + action-on-pick. The move-dialog already had one (its "Home" entry), so non-node rows
  in a picker were established precedent — this generalizes them to plugins.
- **Suppress-when-present over dedup.** Showing both a real node *and* a "create" action for
  the same day is confusing. daily returns `[]` for the action when the day exists, so the
  alias-matched real node is the single answer.

## Rejected alternatives

- **Hardcode "today" in the core switcher.** The exact ADR 0018 anti-goal (core carrying
  feature knowledge). Rejected for the composed seam.
- **Enrich the `text` key with alias terms.** Highlight misalignment (ADR 0017's bug class).
  Rejected for a separate, non-highlighted key.
- **Full `PluginContext` in the switcher.** Heavy plumbing into `__root.tsx` for a
  create+navigate. Rejected for the two-field `SearchActionContext`.
- **Virtual destinations in `/move` now.** The same machinery, but it must *resolve* to a
  node id then move under it (not navigate). Deferred: "Send to Today" already creates-and-
  moves in one shot, and `/move` → "today" works via the alias once the day exists. A clean
  follow-up on the same seam, not a v1 gap.
- **Always-create today (eager or on switcher open)** so the alias always matches. Spawns an
  empty note every day you open search for anything — pollutes the container. Rejected.

## Known rough edges

- **`/move` → "today" only finds an *existing* day** (alias). Creating-on-pick as a move
  destination is the deferred virtual-destination extension above.
- **Alias reverse lookup (`getDayKey`) is O(n)** over the daily index per node, per Fuse
  build (only while a picker is open). Fine at personal scale; cache by id if it bites
  (same note as ADR 0019's badge lookup).
- **The virtual action matches on a `"today".startsWith(q)` prefix** (q ≥ 2 chars) — simple
  and predictable, not fuzzy. "tod" works; a typo like "tdy" won't. Widen later if wanted.
- **Switcher runs actions now.** This is the deliberate softening of ADR 0012's "navigation
  only, no actions". It remains a *jump-to* at heart; actions are narrow, plugin-supplied,
  and resolve to a navigation. Not a general command palette.

## What changed

- **`src/plugins/types.ts`** — `SearchAction`, `SearchActionContext`, and the
  `PluginDef.searchAliases` / `searchActions` seam fields (Seam J).
- **`src/plugins/registry.ts`** — composed `searchAliases(node)` and `searchActions(query, ctx)`.
- **`src/plugins/daily/daily-index.ts`** — `getDayKey(nodeId)` (the sync reverse lookup).
- **`src/plugins/daily/index.tsx`** — `getOrCreateDay`/`ensureContainer`/`ensureDay` now take
  a `TreeIndex`; the `searchAliases` + `searchActions` contributions.
- **`src/components/node-switcher.tsx`** — `aliases` Fuse key (non-highlighted) + a virtual
  "Actions" group with `ActionRow`.
- **`src/components/move-dialog.tsx`** — `aliases` Fuse key (via `getFn`).
- **`e2e/daily-notes.spec.ts`** — Cmd+K create-today-when-absent, and surface-by-alias /
  no-dup-action when present.
- **No `Node` schema change, no `collection.ts` migration, no new route.**
