# ADR 0016: Custom tag colors (chosen per tag, stored, applied via one stylesheet)

Status: accepted (2026-06-22), implemented. Supersedes the *derived tag colors* idea floated in
[ADR 0015](./0015-tag-filtering.md)'s addendum; the rest of 0015 (parsing, filtering, autocomplete)
stands.

## Glossary

- **Tag color** — a color **chosen** for a tag name and stored, applying to **every instance** of
  that tag everywhere (chip, filter pill, autocomplete row). Not derived from the name (the rejected
  ADR 0015 approach), not per-instance.
- **Neutral default** — a tag with no chosen color: a `border-border` outline, no fill (the `.tag`
  rule in `styles.css`). Color is **opt-in**; absence of a stored row means neutral.
- **Tag-colors collection** — `tagColorsCollection` in `src/data/tag-colors.ts`: a TanStack DB
  **localStorage** collection (`dotflowy-oss:tag-colors`) of `{ tag, color }` rows, keyed by the
  **normalized** tag name (no `#`, lowercased). A sibling of `nodesCollection`, not a field on it.
- **Override stylesheet** — a single generated `<style>` (one rule per colored tag, keyed by
  `data-tag`) mounted once via `TagColorStyles`. The *only* thing that paints a tag's color.
- **Picker** — the popover of swatches (a "no color" clear + the 9-color palette) opened by
  **right-clicking** a tag chip or filter pill.

## Decision

A tag's color is **chosen and stored**, defaulting to a **neutral outline**. Three pieces:

1. **Storage — its own collection.** `tagColorsCollection` (localStorage TanStack DB), `{ tag,
   color }` keyed by normalized name. A sibling collection, so it rides the **same persistence and
   future backend-swap / sync path** as nodes (`collection.ts`): a custom color is *shared meaning*,
   not view-state, and should sync across devices once sync lands — unlike recents (ADR 0012), which
   we kept out of the content store precisely because they're ephemeral. No migration to the nodes
   store (separate key). `setTagColor` / `clearTagColor` upsert / delete a row.

2. **Application — one generated stylesheet, keyed by `data-tag`.** Every tag surface already
   carries `data-tag="name"` (chips from `inline-code.ts`, pills and autocomplete rows in their
   components). `TagColorStyles` (mounted once in `__root.tsx`) reads the collection reactively and
   emits one rule per colored tag: `[data-tag="urgent" i][data-tag]{ background/color/border-color }`
   pointing at the named palette vars. So **recoloring a tag updates one CSS rule and every instance
   repaints with zero React re-renders** — no per-node re-decoration. The `i` flag matches any
   casing against the lowercased key; the doubled `[data-tag]` lifts specificity above the
   single-class neutral default so the fill wins.

3. **Picker — right-click, since plain-click is taken.** Plain-clicking a tag *filters* (ADR 0015),
   so color-pick rides the **context menu**: right-click a chip or pill → a popover anchored at the
   pointer with a "no color" (clear → back to neutral) swatch and the 9-color palette; the current
   color is ring-highlighted. Picking writes the collection and closes; outside-click / Escape
   dismiss. Long-press raises `contextmenu` on most touch browsers (inconsistent — accepted for v1).

Palette: **9 named colors** (`red orange amber green teal blue indigo purple pink`) as light/dark
`--tag-<name>` / `--tag-<name>-fg` pairs in `styles.css`. The color id (e.g. `"red"`), not an index,
is stored — stable across palette tweaks.

### Why "no color" is the default (not a derived color)

ADR 0015 first shipped a hash-derived color for every tag. We reversed it: a tag with no chosen
color is now a **neutral outline**, and color is opt-in. Rationale — a derived color is *noise*
masquerading as *meaning*: it looks deliberate but says nothing, and it pre-spends the palette so a
later real choice has to fight an arbitrary default. Neutral-until-chosen keeps color meaningful
(you set it because it means something) and the outline reads cleanly in a dense list.

### Invariants

| Situation | Behavior |
| --------- | -------- |
| Tag with no stored row | Neutral `border-border` outline, no fill. |
| Pick a color | Upserts `{ tag, color }`; **all** instances of that tag repaint at once. |
| "No color" / clear | Deletes the row; back to neutral. |
| Casing | Stored key is normalized (lowercased, no `#`); `#Urgent` and `#urgent` share one color. |
| Unknown color id in storage | Ignored by the generator (treated as no color) — never emits a bad rule. |
| Unsafe tag name in storage | Skipped by the generator (`[\p{L}\p{N}_-]+` guard) — no CSS injection via `data-tag`. |
| Right-click a chip **or** a filter pill | Opens the picker for that tag. |
| Prerender (`/`, ADR 0004) | The store's `getServerSnapshot` returns empty, so `TagColorStyles` renders an empty `<style>` — no collection access on the server. |

## Why

- **A collection, not a localStorage blob or a node field.** A blob wouldn't get the future sync
  path; a node field is wrong (color is global to the *name*, not a node). A sibling collection is
  the project's own pattern (`collection.ts`) and sync-ready.
- **Stylesheet over per-instance class.** A class per chip would need every bullet containing the
  tag to **re-decorate** on a color change — there's no cheap "re-decorate all" signal in the
  per-node store (ADR 0014), and it'd be O(instances) React work. Keying color off `data-tag` in one
  stylesheet makes recolor an O(1) DOM write that the browser applies to all instances for free.
- **Right-click for the gesture.** Plain-click is filtering and chips live in a contentEditable; a
  context menu is the collision-free, Workflowy-accurate gesture. Discoverability is the known cost
  (below).
- **Store the color id, not a palette index.** Survives reordering or restyling the palette.

## Rejected alternatives

- **Derived colors (ADR 0015's first cut).** Hash the name → palette. Zero storage, but the color is
  meaningless and pre-spends the palette. Replaced by chosen-with-neutral-default. (A derived color
  could still return *as* a default someday, but only behind an explicit toggle.)
- **A `color` field on each tag occurrence / on `Node`.** Color is global to the tag name, so
  per-occurrence storage is wrong and a node field has no natural home. Rejected.
- **A plain `localStorage` map (no collection).** Simpler today, but off the sync path — a custom
  color wouldn't follow you to another device once sync lands. Rejected for the sibling collection.
- **Per-instance color class + re-decorate on change.** O(instances) React/DOM churn and needs a
  global re-decorate signal the store doesn't have. The keyed stylesheet is strictly cheaper.
- **Modifier-click or a hover affordance to open the picker.** Modifier-click is undiscoverable;
  a hover button inside a contentEditable chip is fiddly. Right-click is the v1 call; a more visible
  entry point can be added later (see rough edges).

## Known rough edges

- **Right-click isn't discoverable.** No visible "set color" affordance yet. Candidates if it bites:
  a tiny color dot on chip hover, or a row in a future tag context menu. Filter pills are the more
  visible target and accept the same right-click.
- **Touch long-press is browser-dependent.** It raises `contextmenu` on most mobile browsers but not
  all; no dedicated long-press handler in v1.
- **No "create a tag with a color" flow.** You color a tag that already exists in the text; there's
  no palette in the `#` autocomplete yet.
- **No test runner** (AGENTS.md); `typecheck` is the only static gate. Walk by hand: type `#urgent`
  (neutral outline); right-click it → picker; pick red → every `#urgent` (chips, the filter pill if
  active, autocomplete rows) turns red; reload → still red; right-click → "no color" → back to
  outline; `#Urgent` elsewhere shares the color; right-click a filter pill opens the same picker.

## What changed

- **`src/data/tag-colors.ts`** (new) — `tagColorsCollection`, the `TAG_COLORS` palette + `TagColor`
  type, `setTagColor` / `clearTagColor`, the `tagColorsCss` generator, and the reactive reads
  (`useTagColorRows`, `useTagColor`) mirroring `tree-store`'s subscribe pattern (prerender-safe).
- **`src/data/tags.ts`** — derived-color helpers (`tagColorIndex` / `tagColorClass` /
  `TAG_COLOR_COUNT`) removed; `normalizeTag` added (shared key/case-fold helper).
- **`src/components/tag-color-menu.tsx`** (new) — `TagColorStyles` (the generated `<style>`, mounted
  in `__root.tsx`) and `TagColorMenu` (the picker popover).
- **`src/components/inline-code.ts`** — chip drops the derived color class; renders just the neutral
  `.tag` + `data-tag`.
- **`src/components/OutlineEditor.tsx`** — `onContextMenu` opens the picker for the right-clicked tag
  (chip or pill); filter pills carry `data-tag`; removed `tagColorClass`/`cn` usage.
- **`src/components/tag-menu.tsx`** — autocomplete rows carry `data-tag`, drop the color class.
- **`src/styles.css`** — named `--tag-<name>` palette (light/dark) replaces the `.tag-cN` slots;
  neutral outline default for `.tag` / `.tag-pill` / `.tag-option`.
- **No nodes-schema change, no `collection.ts` migration, no new route.**
</content>
