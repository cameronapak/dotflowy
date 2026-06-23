# Dotflowy OSS

An open-source, local-first outline editor in the spirit of [Workflowy](https://workflowy.com). Built with [TanStack Start](https://tanstack.com/start) and [TanStack DB](https://tanstack.com/db).

Your data lives entirely in your browser. No account, no server, no sync (yet).

## Status

Local-first and single-player — your outline lives in `localStorage` and syncs across tabs in the same browser, with no multi-device sync yet.

What works:

- Nested bullets with inline editing; collapse / expand subtrees (hover chevron in the gutter)
- Zoom into any bullet as a temporary root (click its dot), with a breadcrumb trail back out
- Tasks: a checkbox marks complete; a "show completed" toggle hides done items
- Drag the bullet dot to reorder **and** reparent in one drop (mouse + touch)
- Markdown-style rich text: `inline code`, `[links](https://…)` that fold to a clean label, and `#tags`
- Clicking a `#tag` filters the outline in place; right-click a tag to color it
- Bookmarks (the header star pins the current zoom view) and a `Cmd/Ctrl+K` quick-switcher to jump anywhere
- A `/` command palette (to-do, plain bullet, move) and a move-to dialog
- Dark mode, undo / redo

### Keyboard

| Key | Action |
|---|---|
| `Enter` | Split at the caret into a new sibling below (at the end of an expanded bullet, adds a child at the top instead) |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `Cmd/Ctrl+Shift+↑` / `↓` | Move the bullet among siblings; outdent at the edge |
| `Cmd/Ctrl+↑` / `↓` | Collapse / expand |
| `Cmd/Ctrl+Enter` or `Cmd/Ctrl+D` | Toggle complete |
| `Cmd/Ctrl+.` / `Cmd/Ctrl+,` | Zoom in / out |
| `Backspace` on an empty bullet | Delete it and focus the previous one |
| `Arrow ↑` / `↓` at line edges | Move between bullets (preserves the caret column) |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` | Undo / redo |
| `Cmd/Ctrl+K` | Open the quick-switcher |

Not built yet: sharing, multi-device sync.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | TanStack Start (SPA mode) | File-based routing, no SSR needed for a local-first app |
| Data | TanStack DB `localStorageCollection` | Optimistic mutations, cross-tab sync, schema-validated, and a clean upgrade path to a real backend |
| Validation | Zod 4 | Standard-schema compatible, drives the collection's item type |
| Build | Vite 8 | What Start uses |
| Runtime | Bun (dev/install) | Fast; npm/pnpm/yarn work too |

## Run it

```sh
bun install
bun run dev      # http://localhost:3000 (or next free port)
```

Other useful scripts:

```sh
bun run build      # production build
bun run preview    # preview the production build
bun run typecheck  # tsc --noEmit
bun run test:e2e   # Playwright end-to-end tests (chromium)
```

## How it works

### Data model

Every bullet is one row in a single TanStack DB collection. The outline tree is reconstructed in memory at read time.

```
Node {
  id, parentId, prevSiblingId,        // tree shape + sibling order
  text, isTask, completed, collapsed, // content + UI state
  bookmarkedAt,                       // null, or the ms it was pinned (also the bookmark sort key)
  createdAt, updatedAt
}
```

Sibling order is a linked list via `prevSiblingId` (the Workflowy/Notion approach). Inserting between two bullets is O(1) and never requires renumbering. Reordering is relinking pointers.

See `src/data/tree.ts` for the index builder and `src/data/mutations.ts` for the structural operations — insert, indent / outdent, the fused `moveNode` (drag reorder + reparent), move up / down, delete — plus the field setters (text, task, completed, collapsed, bookmark). Each preserves the linked-list invariant.

### Why flat, not nested

A flat list of rows maps cleanly onto a sync backend later. Nested JSON would force deep-merge on every keystroke. Flat rows keep moves cheap and make the eventual ElectricSQL swap a schema change, not a rewrite.

### Persistence

`nodesCollection` (`src/data/collection.ts`) wraps `localStorageCollectionOptions`. We mutate directly (`collection.insert / update / delete`) and the collection persists to `localStorage` and broadcasts changes to other tabs via `storage` events.

### Plugins

The editor is a small core extended by **plugins** compiled into the bundle (an internal registry, not runtime-loaded). `code`, `links`, `tags`, and `todos` are each a plugin built on the same public API, so the core carries no feature-specific branches. A plugin registers against a fixed set of *seams* — inline tokens, delegated clicks, `/` commands, keymap, row slots, view transforms, autocomplete menus, paste / autoformat, and side-collections. Adding a feature is a folder under `src/plugins/<name>/` plus one line in `src/plugins/index.ts`. See [ADR 0018](docs/adr/0018-plugin-architecture.md) (the design lives in `docs/adr/`).

## Upgrading to real-time sync

The architecture is intentionally backend-agnostic. When you want multi-device sync, swap the collection's options creator and add an `onInsert / onUpdate / onDelete` handler that talks to your API. None of the components or tree logic changes.

```ts
// Before (local-only)
import { localStorageCollectionOptions } from '@tanstack/react-db'

export const nodesCollection = createCollection(
  localStorageCollectionOptions({ id: 'nodes', storageKey: '...', getKey, schema }),
)

// After (ElectricSQL + Postgres)
import { electricCollectionOptions } from '@tanstack/electric-db-collection'

export const nodesCollection = createCollection(
  electricCollectionOptions({
    id: 'nodes',
    shape: { url: '...', params: { table: 'nodes' } },
    getKey: (n) => n.id,
    schema: nodeSchema,
    // persistence handlers talk to your Postgres write path
  }),
)
```

`useLiveQuery`, `insert`, `update`, `delete` all keep working.

## Project layout

```
src/
  routes/
    __root.tsx        # HTML shell, global CSS, app-wide providers
    index.tsx         # the outline at the top level
    $nodeId.tsx       # the same outline zoomed into one bullet
  components/
    OutlineEditor.tsx   # reads tree, focus + command dispatch, the zoom view
    OutlineNode.tsx     # one bullet + its subtree (memoized, per-node store subscription)
    inline-code.ts      # contentEditable decorate / caret engine (source-offset aware)
    menu-engine.tsx     # generic caret-autocomplete engine
    slash-menu.tsx      # the `/` command palette
    node-switcher.tsx   # Cmd+K quick-switcher
    move-dialog.tsx     # the `/move` destination picker
    bookmarks.tsx       # header star + bookmark browsing
    use-drag-reorder.ts # bullet-dot drag (reorder + reparent)
    Header.tsx, paste.ts, flash-node.ts, *-provider.tsx, *-toggle.tsx, ui/
  data/
    schema.ts         # zod schema, Node type
    collection.ts     # TanStack DB localStorage collection (+ field migrations)
    tree.ts           # flat-list -> TreeIndex, trail / id / time helpers
    tree-store.ts     # per-node subscriptions (useNode / useVisibleChildIds)
    mutations.ts      # insert / move / delete / field setters
    history.ts        # undo / redo capture
    tags.ts, tag-colors.ts, links.ts  # pure parsing + the tag-color side-collection
    seed.ts           # first-run welcome bullets
    useTree.ts        # useLiveQuery hook
  plugins/            # the editor's plugin layer (ADR 0018)
    index.ts          # the one ordered array: [code, links, tags, todos]
    types.ts          # the typed seam contract (definePlugin)
    registry.ts       # composes every plugin's registrations once at load
    code/ links/ tags/ todos/   # one folder per plugin
  router.tsx
  styles.css
docs/adr/             # numbered architecture decision records
vite.config.ts        # SPA mode
```

## License

MIT. See [LICENSE](./LICENSE).
