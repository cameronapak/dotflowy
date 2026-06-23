# Dotflowy OSS

An open-source, local-first outline editor in the spirit of [Workflowy](https://workflowy.com). Built with [TanStack Start](https://tanstack.com/start) and [TanStack DB](https://tanstack.com/db).

Your data lives entirely in your browser. No account, no server, no sync (yet).

## Status

Very early. v1 scope only:

- Nested bullets with inline editing
- Checkbox to mark complete
- Collapse / expand subtrees (hover chevron in the gutter)
- Zoom into a bullet as a temporary root (click the bullet dot)
- Keyboard shortcuts:
  - `Enter` — new sibling (at the end of an expanded bullet, adds a child at the top instead)
  - `Tab` / `Shift+Tab` — indent / outdent
  - `Backspace` on an empty bullet — delete and focus the previous one
  - `Arrow Up` / `Arrow Down` at line edges — move between bullets
  - `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` — undo / redo
- Persists to `localStorage`; syncs across browser tabs automatically

Not built yet: sharing, mobile gestures, multi-device sync.

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
  id, parentId, prevSiblingId,   // tree shape + sibling order
  text, completed, collapsed,    // content + UI state
  createdAt, updatedAt
}
```

Sibling order is a linked list via `prevSiblingId` (the Workflowy/Notion approach). Inserting between two bullets is O(1) and never requires renumbering. Reordering is relinking pointers.

See `src/data/tree.ts` for the index builder and `src/data/mutations.ts` for the four core operations (insert / indent / outdent / delete), each of which preserves the linked-list invariant.

### Why flat, not nested

A flat list of rows maps cleanly onto a sync backend later. Nested JSON would force deep-merge on every keystroke. Flat rows keep moves cheap and make the eventual ElectricSQL swap a schema change, not a rewrite.

### Persistence

`nodesCollection` (`src/data/collection.ts`) wraps `localStorageCollectionOptions`. We mutate directly (`collection.insert / update / delete`) and the collection persists to `localStorage` and broadcasts changes to other tabs via `storage` events.

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
    __root.tsx       # HTML shell, global CSS
    index.tsx        # the single page
  components/
    OutlineEditor.tsx  # reads tree, focus management, command dispatch
    OutlineNode.tsx    # one bullet + its subtree
  data/
    schema.ts         # zod schema, Node type
    collection.ts     # TanStack DB localStorage collection
    tree.ts           # flat-list -> TreeIndex, id/time helpers
    mutations.ts      # insert / indent / outdent / delete / setText
    seed.ts           # first-run welcome bullets
    useTree.ts        # useLiveQuery hook
  router.tsx
  styles.css
vite.config.ts        # SPA mode
```

## License

MIT. See [LICENSE](./LICENSE).
