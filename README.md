# Dotflowy OSS

An open-source, local-first outline editor in the spirit of [Workflowy](https://workflowy.com). Built with [TanStack Start](https://tanstack.com/start) and [Jazz](https://jazz.tools).

Your data lives in your browser (persisted to OPFS via Jazz's local-first runtime). No account today; multi-device sync is the next step (last-write-wins per field, single user across their own devices).

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
- Persists locally via Jazz (OPFS); syncs across browser tabs automatically

Not built yet: tags, sharing, multi-device sync.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | TanStack Start (SPA mode) | File-based routing, no SSR needed for a local-first app |
| Data | Jazz 2.0 (`jazz-tools`) | Local-first WASM runtime, OPFS persistence, last-write-wins-per-field sync built in |
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
```

## How it works

### Data model

Every bullet is one row in a single Jazz table. The outline tree is reconstructed in memory at read time.

```
Node {
  id, parentId, prevSiblingId,        // tree shape + sibling order
  text, isTask, completed, collapsed, // content + UI state
  bookmarkedAt, createdAt, updatedAt
}
```

Sibling order is a linked list via `prevSiblingId` (the Workflowy/Notion approach). Inserting between two bullets is O(1) and never requires renumbering. Reordering is relinking pointers.

See `src/data/tree.ts` for the index builder and `src/data/mutations.ts` for the four core operations (insert / indent / outdent / delete), each of which preserves the linked-list invariant.

### Why flat, not nested

A flat list of rows maps cleanly onto the sync backend. Nested JSON would force deep-merge on every keystroke. Flat rows keep moves cheap and keep per-field last-write-wins conflict resolution well-defined.

### Persistence

The Jazz client (`src/data/jazz.ts`) is created once as a module singleton (`createDb`, anonymous local-first, OPFS-persistent). We mutate directly (`getDb().insert / update / delete`) and Jazz persists to OPFS, coordinates across browser tabs, and (once a server URL is configured) syncs across devices. `src/data/tree-store.ts` holds the one `db.subscribeAll` subscription and derives the shared in-memory index the components read.

## Multi-device sync

Sync is single user across their own devices, resolved last-write-wins per field (no CRDT) — exactly Jazz's default merge behavior. The local OPFS document is the working copy today; pointing the client at a Jazz server URL (with auth) turns on device-to-device sync without touching the component or tree logic. See [ADR 0016](./docs/adr/0016-jazz-sync-backend.md) for the decision and the open edges (auth, the schema-catalogue server call, fractional indexing).

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
    schema.ts         # Jazz table + app, Node type
    jazz.ts           # Jazz client singleton, getDb, migration, ready gate
    tree-store.ts     # one db.subscribeAll -> shared TreeIndex + narrow hooks
    tree.ts           # flat-list -> TreeIndex, id/time helpers
    mutations.ts      # insert / indent / outdent / delete / setText
    history.ts        # snapshot undo
    seed.ts           # first-run welcome bullets
    useTree.ts        # whole-index hook (wraps tree-store)
  router.tsx
  styles.css
vite.config.ts        # SPA mode
```

## License

MIT. See [LICENSE](./LICENSE).
