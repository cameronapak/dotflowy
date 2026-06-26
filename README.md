# Dotflowy

An outline editor in the spirit of [Workflowy](https://workflowy.com). Built with [TanStack Start](https://tanstack.com/start) and [TanStack DB](https://tanstack.com/db).

Local-first at heart, with an optional Cloudflare deployment that syncs your outline across devices via a per-user [Durable Object](https://developers.cloudflare.com/durable-objects/), behind email + password accounts ([Better Auth](https://www.better-auth.com)).

## Status

Your outline is stored in a TanStack DB collection. By default that's backed by a per-user **Cloudflare Durable Object** (its colocated SQLite) through a Worker — writes go to `/api/nodes`, live reads over `/api/sync` (WebSocket) — so edits show up on your other tabs/devices without refocusing. See [the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object). The flat-row data model means swapping the backend is a collection-options change, not a rewrite.

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

Not built yet: sharing, email verification.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | TanStack Start (SPA mode) | File-based routing, no SSR needed for a local-first app |
| Data | TanStack DB query collections over a per-user Durable Object | Optimistic mutations, schema-validated; the flat-row model swaps backends by changing collection options. Nodes use `/api/nodes`; plugin side data (tag colors, daily index) uses a generic `/api/kv` store ([the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object)). |
| Backend | Cloudflare Worker + Durable Objects | One Worker serves the SPA and routes the `/api/nodes` + `/api/kv` sync APIs to a per-user Durable Object ([the auth gate](docs/DECISIONS.md#the-auth-gate)) |
| Auth | Better Auth (email + password) | Self-serve signup; its `user` table is the identity store and `user.id` keys each user's DO. Sessions in D1 |
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

The repo deploys to **Cloudflare Workers**: one Worker (`worker/index.ts`) serves the static SPA *and* routes the `/api/nodes` + `/api/kv` sync APIs to a **per-user Durable Object**, behind **Better Auth** accounts ([the auth gate](docs/DECISIONS.md#the-auth-gate)). Config is in `wrangler.jsonc`. Full design: [the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object).

```sh
# local dev (two terminals): Vite HMR + a local Worker (DO + D1) it proxies /api to
cp .dev.vars.example .dev.vars   # once: add a BETTER_AUTH_SECRET (openssl rand -base64 32)
bun run db:migrate:local   # once: apply the local D1 schema (auth tables + the DO import source)
bun run dev:api            # wrangler dev (Worker + DO + local D1) on :8787
bun run dev                # vite dev (proxies /api -> :8787)

# or a production-like single-server preview
bun run cf:dev             # build + wrangler dev

# ship it
wrangler secret put BETTER_AUTH_SECRET   # once: the auth signing secret
bun run db:migrate:remote  # before the first deploy
bun run deploy             # build + wrangler deploy
```

`build:cf` copies the TanStack Start shell (`_shell.html`) to `index.html` so the root and client routes (e.g. `/<nodeId>` zoom views) resolve through the SPA fallback.

**Auth.** Identity is **Better Auth** (email + password self-serve signup), sessions in D1. The static shell is public so the login screen loads; only `/api/nodes` + `/api/kv` require a session. Set `BETTER_AUTH_SECRET` (`wrangler secret put`) in prod and `.dev.vars` locally — without it the Worker fails closed. To carry a pre-auth outline (the constant `'default'` DO) into your real account, set the `OWNER_USER_ID` secret to your `user.id` after signing up. See [the auth gate](docs/DECISIONS.md#the-auth-gate).

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

Today, **nodes sync live** over a per-user WebSocket (`/api/sync`): optimistic writes still POST/PATCH/DELETE `/api/nodes`, and the DO broadcasts deltas to every connected tab/device. **Side-collections** (tag colors, daily index) still reconcile on tab focus (`refetchOnWindowFocus`). Not yet built:

- **Sharing** — a node + subtree shared with another user (a future "mount" pointer; see [the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object)).

A returning owner's pre-DO outline is carried over **server-side**: the Worker does a one-time, non-destructive copy of any pre-DO D1 rows into the owner's Durable Object on first `/api/sync` connect (`ensureSeeded`). There is no client-side `localStorage` migration — localStorage is browser-scoped but accounts are per-user, so importing it would leak one browser's leftover outline into every new account that signed in there.

See [the sync design](docs/DECISIONS.md#sync-via-a-per-user-durable-object) for the design and rejected alternatives (incl. why a Durable Object over D1-direct or ElectricSQL).

## Project layout

```
src/
  routes/
    __root.tsx        # HTML shell, global CSS, app-wide providers
    index.tsx         # the outline at the top level
    $nodeId.tsx       # the same outline zoomed into one bullet
  lib/
    auth-client.ts    # Better Auth browser client (useSession / signIn / signUp / signOut)
    utils.ts          # cn() and small helpers
  components/
    auth-screen.tsx     # login / signup screen (shown by the root AuthGate when signed out)
    sign-out-button.tsx # header sign-out control
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
    seed.ts           # first-run bootstrap: seed welcome bullets when the outline is empty
    useTree.ts        # useLiveQuery hook
  plugins/            # the editor's plugin layer (see docs/DECISIONS.md)
    index.ts          # the one ordered array: [code, links, tags, todos, daily]
    types.ts          # the typed seam contract (definePlugin)
    registry.ts       # composes every plugin's registrations once at load
    code/ links/ tags/ todos/ daily/   # one folder per plugin
  router.tsx
  styles.css
worker/               # Cloudflare Worker: serves the SPA + routes /api/nodes + /api/kv to per-user DOs
  index.ts            #   session gate + resolveUserId + routes /api to the user's DO (own tsconfig)
  auth.ts             #   createAuth(env): Better Auth (email + password), sessions in D1
  outline-do.ts       #   UserOutlineDO: per-user SQLite (nodes + kv), the outline store
migrations/           # D1 SQL migrations (0001 nodes, 0002 kv = DO import source; 0003 Better Auth)
wrangler.jsonc        # Worker + assets + Durable Object + D1 bindings (+ nodejs_compat)
docs/DECISIONS.md     # the few load-bearing decisions (history in git log)
vite.config.ts        # SPA mode + /api dev proxy
```

## License

Copyright © FAITH TOOLS SOFTWARE SOLUTIONS, LLC. Released under the [O'Saasy License](./LICENSE). Source is available for learning, modification, and self-hosting; offering a competing hosted SaaS product is reserved to the copyright holder.
