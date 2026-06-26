# Dotflowy OSS

An open-source outline editor in the spirit of [Workflowy](https://workflowy.com). Built with [TanStack Start](https://tanstack.com/start) and [TanStack DB](https://tanstack.com/db).

Local-first at heart, with an optional single-user Cloudflare deployment that syncs your outline across devices via a per-user [Durable Object](https://developers.cloudflare.com/durable-objects/), gated by either [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) or a built-in HTTP Basic Auth fallback (so it works before you set Access up).

## Status

Your outline is stored in a TanStack DB collection. By default that's backed by a per-user **Cloudflare Durable Object** (its colocated SQLite) through a Worker (`/api/nodes`) — so it syncs across your devices (it re-pulls on tab focus; real-time push is not built yet). See [the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object). The flat-row data model means swapping the backend is a collection-options change, not a rewrite.

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
| `Cmd/Ctrl+Shift+↑` / `↓` | Move the bullet among siblings; at the edge reparent into the parent's adjacent sibling |
| `Cmd/Ctrl+↑` / `↓` | Collapse / expand |
| `Cmd/Ctrl+Enter` or `Cmd/Ctrl+D` | Toggle complete |
| `Cmd/Ctrl+.` / `Cmd/Ctrl+,` | Zoom in / out |
| `Backspace` on an empty bullet | Delete it and focus the previous one |
| `Arrow ↑` / `↓` at line edges | Move between bullets (preserves the caret column) |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` | Undo / redo |
| `Cmd/Ctrl+K` | Open the quick-switcher |

Not built yet: sharing, real-time multi-device push (sync today reconciles on tab focus), multi-user accounts.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | TanStack Start (SPA mode) | File-based routing, no SSR needed for a local-first app |
| Data | TanStack DB query collections over a per-user Durable Object | Optimistic mutations, schema-validated; the flat-row model swaps backends by changing collection options. Nodes use `/api/nodes`; plugin side data (tag colors, daily index) uses a generic `/api/kv` store ([the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object)). |
| Backend | Cloudflare Worker + Durable Objects | One Worker serves the SPA and routes the `/api/nodes` + `/api/kv` sync APIs to a per-user Durable Object; single-user, gated by Cloudflare Access or an HTTP Basic Auth fallback ([the auth gate](docs/DECISIONS.md#the-auth-gate)) |
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

## Deploy

The repo deploys to **Cloudflare Workers**: one Worker (`worker/index.ts`) serves the static SPA *and* routes the `/api/nodes` + `/api/kv` sync APIs to a **per-user Durable Object**, gated by **Cloudflare Access** (or an HTTP Basic Auth fallback — [the auth gate](docs/DECISIONS.md#the-auth-gate)). Config is in `wrangler.jsonc`. Full design: [the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object).

```sh
# local dev (two terminals): Vite HMR + a local Worker (DO + D1) it proxies /api to
bun run db:migrate:local   # once: create the local D1 schema (the DO's import source)
bun run dev:api            # wrangler dev (Worker + DO + local D1) on :8787
bun run dev                # vite dev (proxies /api -> :8787)

# or a production-like single-server preview
bun run cf:dev             # build + wrangler dev

# ship it
bun run db:migrate:remote  # before the first deploy
bun run deploy             # build + wrangler deploy
```

`build:cf` copies the TanStack Start shell (`_shell.html`) to `index.html` so the root and client routes (e.g. `/<nodeId>` zoom views) resolve through the SPA fallback.

**Auth.** The Worker authenticates the single user one of two ways. The simplest, no-dashboard path is **HTTP Basic Auth**: set a secret with `wrangler secret put APP_PASSWORD`, and the browser prompts on first load. The cleaner long-term path is **Cloudflare Access** on a custom domain (a one-time Zero Trust dashboard step); when its email header is present it takes precedence, no code change. Until one of these is in place, the Worker fails closed (the site is locked). See [the auth gate](docs/DECISIONS.md#the-auth-gate).

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

A flat list of rows maps cleanly onto a sync backend. Nested JSON would force deep-merge on every keystroke. Flat rows keep moves cheap and made each backend move (localStorage → D1 → a per-user Durable Object) a `nodes` table swap, not a rewrite.

### Persistence

`nodesCollection` (`src/data/collection.ts`) is a TanStack DB **query collection**: the `queryFn` GETs the full node set from `/api/nodes` and the mutation handlers POST/PATCH/DELETE through the same Worker, which **routes each request to the caller's Durable Object** and reads/writes the `nodes` table in its colocated SQLite. We mutate directly (`collection.insert / update / delete`); writes are optimistic locally and persisted server-side, reconciling across devices on tab focus. See [the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object).

Plugin **side-collections** (tag colors, the daily index) sync the same way, over a generic `/api/kv` store (one `kv` table in the same DO, namespaced by collection) — so a custom tag color or a daily-note follows you across devices too. See [the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object).

### Plugins

The editor is a small core extended by **plugins** compiled into the bundle (an internal registry, not runtime-loaded). `code`, `links`, `tags`, and `todos` are each a plugin built on the same public API, so the core carries no feature-specific branches. A plugin registers against a fixed set of *seams* — inline tokens, delegated clicks, `/` commands, keymap, row slots, view transforms, autocomplete menus, paste / autoformat, and side-collections. Adding a feature is a folder under `src/plugins/<name>/` plus one line in `src/plugins/index.ts`. See [the plugin architecture](docs/DECISIONS.md#plugin-architecture).

## Sync: where it stands

The collection interface is backend-agnostic — that's how moving the backend (localStorage → D1 → a per-user Durable Object) touched only `collection.ts` and the Worker, leaving every component and the tree logic unchanged.

Today, sync is **single-user, near-real-time on tab focus**: optimistic local writes are persisted to the user's Durable Object, and the collection re-pulls server state when you refocus the tab (`refetchOnWindowFocus`). Not yet built:

- **Real-time push** — the per-user Durable Object *streaming* changes over WebSocket, instead of focus-driven refetch. (The DO already holds the data; the live-push layer is the remaining piece.)
- **Multi-user** — the gate scopes to one identity today; real accounts (sign-up/login) are a larger step.

A returning user's pre-sync outline is **imported from `localStorage` once** on first load against an empty server (`src/data/import-legacy.ts`); separately, the Worker does a one-time non-destructive copy of any pre-DO D1 rows into the user's Durable Object. Neither strands existing data.

See [the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object) for the design and rejected alternatives (incl. why a Durable Object over D1-direct or ElectricSQL).

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
    collection.ts     # TanStack DB query collection over the Worker (/api/nodes)
    api.ts            # REST client for the /api/nodes Worker
    kv-api.ts         # REST client for the generic /api/kv side-collection store
    query-client.ts   # shared TanStack Query client (focus refetch = sync)
    tree.ts           # flat-list -> TreeIndex, trail / id / time helpers
    tree-store.ts     # per-node subscriptions (useNode / useVisibleChildIds)
    mutations.ts      # insert / move / delete / field setters
    history.ts        # undo / redo capture
    tags.ts, tag-colors.ts, links.ts  # pure parsing + the tag-color side-collection (synced via /api/kv)
    seed.ts           # first-run bootstrap: import legacy localStorage, else seed welcome bullets
    import-legacy.ts  # one-time pre-sync localStorage -> store outline import
    useTree.ts        # useLiveQuery hook
  plugins/            # the editor's plugin layer (see docs/DECISIONS.md)
    index.ts          # the one ordered array: [code, links, tags, todos, daily]
    types.ts          # the typed seam contract (definePlugin)
    registry.ts       # composes every plugin's registrations once at load
    code/ links/ tags/ todos/ daily/   # one folder per plugin
  router.tsx
  styles.css
worker/               # Cloudflare Worker: serves the SPA + routes /api/nodes + /api/kv to per-user DOs
  index.ts            #   auth gate + resolveUserId + routes /api to the user's DO (own tsconfig)
  outline-do.ts       #   UserOutlineDO: per-user SQLite (nodes + kv), the outline store
migrations/           # D1 SQL migrations (0001 nodes, 0002 kv) — now the DO import source
wrangler.jsonc        # Worker + assets + Durable Object + D1 bindings
docs/DECISIONS.md     # the few load-bearing decisions (history in git log)
vite.config.ts        # SPA mode + /api dev proxy
```

## License

MIT. See [LICENSE](./LICENSE).
