// Todos plugin (ADR 0018). Completion is the todo plugin's concept (D9): a plain
// outline is just nestable text; installing this plugin is what makes nodes
// completable and grants hide-completed. The `completed`/`isTask` FIELDS stay
// node slots for hot-path speed (D9's named exception), but their meaning,
// transforms, and UI live here.
//
// This slice contributes only Seam G -- the hide-completed view transform, which
// the core composes into its per-node visibility predicate (so the store stops
// special-casing `completed`). The interaction surface -- the checkbox slot (F),
// Mod+Enter / Mod+D (D), `/todo` (C), and the `[]` autoformat (I) -- follows in
// the next slice.

import { definePlugin } from "../types";

export default definePlugin({
  id: "todos",

  // Seam G: when show-completed is off, a completed bullet (and its whole
  // subtree) drops out of the render. The core ORs this into the composed
  // `isHidden` predicate; `useVisibleChildIds` and the tag filter both apply it,
  // so neither hardcodes `completed` any longer (D9).
  viewTransforms: [
    {
      id: "hide-completed",
      hidesNode: (node, ctx) => !ctx.showCompleted && node.completed,
    },
  ],
});
