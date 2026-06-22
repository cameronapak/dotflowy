# ADR 0003: Zoom-to-node via the View Transitions API

Status: accepted (2026-06-21)

## Glossary

- **Zoom** — making one bullet the temporary root of the outline, so only it and its
  subtree are shown. Clicking a bullet's dot zooms in; the breadcrumb zooms back out.
- **Root** — the node currently acting as the top of the view (`rootId`). `null` means
  the whole document.
- **Pivot** — the single node that swaps roles between the two views of a zoom: it is a
  list item in one view and the title in the other. The browser morphs this one element.

## Decision

Zoom is **URL-driven** and animated as a **shared-element morph** through the View
Transitions API.

### 1. The route owns `rootId`.

`routes/index.tsx` renders `<OutlineEditor rootId={null}>`; `routes/$nodeId.tsx` renders
`<OutlineEditor rootId={nodeId}>`. The zoom view is keyed `key={nodeId}` so it remounts
per node, preventing stale view-transition names from leaking between consecutive zooms.

### 2. The bullet dot zooms; the chevron collapses.

Zoom lives on the bullet dot. Collapse/expand is the hover chevron in the left gutter.
These are deliberately separate controls.

### 3. The animation is a pivot morph driven by TanStack Router's `viewTransition`.

Router wraps navigation in `document.startViewTransition`. The pivot claims
`view-transition-name: zoom-target` in *both* views, so the browser morphs it:

- Zoom in → pivot is the clicked node (list item → title).
- Zoom out → pivot is the current root (title → list item).

### 4. The pivot id travels in history state.

`HistoryState` is module-augmented with `pivotId` in `OutlineEditor.tsx`. The incoming
view names the pivot declaratively (`.vt-morph` class + inline `viewTransitionName`);
`navigateZoom` names it imperatively in the outgoing view before navigating.

### 5. The pivot's flex box shrinks to fit-content during the transition only.

`:root:active-view-transition-type(zoom) .vt-morph { flex-grow: 0 }` makes both the old
and new boxes wrap their text, so the morph is a clean scale + translate. Without it the
element slides from the stretched right edge. Reduced motion is respected
(`prefersReducedMotion()` + a CSS `@media` guard).

## Why

Driving zoom from the URL makes it linkable, back/forward-navigable, and stateless in the
editor. The pivot morph gives a physical sense of "this bullet became the page" without a
bespoke animation engine — the browser does the interpolation. Carrying `pivotId` in
history state is what lets both the imperative (outgoing) and declarative (incoming) sides
agree on which element to morph across a navigation boundary.

## Operational note

Screenshots cannot capture view-transition overlays — they show the settled DOM, so a
morph always looks "done." Verify by instrumenting `document.startViewTransition` and
asserting which element holds `view-transition-name`, not by screenshotting mid-animation.
