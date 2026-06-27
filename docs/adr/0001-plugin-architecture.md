# Plugin architecture

The editor is a small core extended by **plugins compiled into the bundle** — an internal
registry in `src/plugins/`, *not* runtime-loaded. `code`, `links`, `tags`, `todos`, `daily`, and
`route-bible` are themselves plugins, so the core carries no feature-specific branches. A plugin
registers into a fixed, finite set of **seams** (inline tokens, delegated clicks, `/` commands,
keymap, row/header slots, view transforms, caret menus, paste/autoformat, side-collections, search
providers). The live seam map and current owners are the Plugins section of `AGENTS.md`; this is
the design rationale.

**Two-tier data ownership is the load-bearing rule.** The decider: *does any core view-transform
(show/hide, fade, sort, breadcrumb) need this field?* Yes → it's a core primitive on `Node`. No →
it's a **side-collection keyed by node id**, never a `Node` field (clean uninstall, no migration,
rides the sync path).

**Don't:**
- Add plugin-owned fields to the `Node` schema (migrations, the no-zod-defaults problem, sync
  churn, orphan fields on uninstall). Plugin data is a side-collection — this is also why
  "protected node" is a *composed predicate*, not a `protected:` column.
- Give each token its own regex/scan — N plugins must not mean N passes. The core composes one
  alternation, one `matchAll`, and owns escaping (tokens return structured `El`/`WidgetEl`, never
  raw HTML).
- Run arbitrary per-keystroke plugin code in the decorator, or reach for runtime/after-install
  plugin loading (deferred — a module loader + sandbox + capability model this project doesn't
  need).

**The one named exception:** `completed`/`isTask` stay `Node` fields even though completion is the
todo plugin's concept — because hide-completed and fade-inheritance read them every render, and a
side-collection join on the hottest path isn't worth it. Core declares the column; exactly one
plugin reads it. Don't generalize this into "plugins can add fields."
