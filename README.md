<p align="center">
  <img src="/public/favicon-light.svg" alt="Dotflowy" width="120" height="120" />
</p>

<h1 align="center">Dotflowy (beta)</h1>

<p align="center">
  <strong>An infinite outliner for your thoughts and tasks</strong><br/>
	<span>If Workflowy was open source and had the extensibility of Obsidian plugins</span>
</p>

<p align="center">
  <a href="https://app.dotflowy.com"><strong>app.dotflowy.com</strong></a>
</p>

---

Built with [TanStack Start](https://tanstack.com/start) and [TanStack DB](https://tanstack.com/db).

Local-first at heart, with an optional Cloudflare deployment that syncs your outline across devices via a per-user [Durable Object](https://developers.cloudflare.com/durable-objects/), behind email + password accounts ([Better Auth](https://www.better-auth.com)).

![GitHub Stars](https://www.shieldcn.dev/github/stars/cameronapak/dotflowy.svg?variant=secondary&size=sm)
![Package mgr · Bun](https://www.shieldcn.dev/badge/Package_mgr-Bun-000000.svg?logo=bun&variant=branded&size=sm)
![Language · TypeScript](https://www.shieldcn.dev/badge/Language-TypeScript-3178C6.svg?logo=typescript&variant=branded&size=sm)
![Bundler · Vite](https://www.shieldcn.dev/badge/Bundler-Vite-646CFF.svg?logo=vite&variant=branded&size=sm)
![Tests · Playwright](https://www.shieldcn.dev/badge/Tests-Playwright-2EAD33.svg?logo=playwright&variant=branded&size=sm)
![Hosting · Cloudflare Workers](https://www.shieldcn.dev/badge/Hosting-Cloudflare_Workers-F38020.svg?logo=cloudflare&variant=branded&size=sm)
![TanStack Query](https://www.shieldcn.dev/badge/Stack-TanStack_Query-FF4154.svg?logo=reactquery&variant=branded&size=sm)
![Better Auth](https://www.shieldcn.dev/badge/Stack-Better_Auth-000000.svg?logo=ri%3ARiShieldKeyholeFill&variant=branded&size=sm)
![React](https://www.shieldcn.dev/badge/Stack-React-61DAFB.svg?logo=react&variant=branded&size=sm)
![Effect](https://www.shieldcn.dev/badge/Stack-Effect-5B5BD6.svg?variant=secondary&size=sm)
![Tailwind CSS](https://www.shieldcn.dev/badge/Stack-Tailwind_CSS-06B6D4.svg?logo=tailwindcss&variant=branded&size=sm)
![Agent-friendly AGENTS.md](https://www.shieldcn.dev/badge/Agent--friendly-AGENTS.md-D97757.svg?variant=secondary&size=sm)

## Status

Your outline is stored in a TanStack DB collection. By default that's backed by a per-user **Cloudflare Durable Object** (its colocated SQLite) through a Worker — writes go to `/api/nodes`, live reads over `/api/sync` (WebSocket) — so edits show up on your other tabs/devices without refocusing. See [the sync design](docs/adr/0008-sync-via-a-per-user-durable-object.md). The flat-row data model means swapping the backend is a collection-options change, not a rewrite.

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
- An MCP server (`/mcp`, OAuth-gated) so AI agents can read and edit the outline — add to today's daily note, mirror nodes, search — with live sync into open editors

### Keyboard

| Key                               | Action                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Enter`                           | Split at the caret into a new sibling below (at the end of an expanded bullet, adds a child at the top instead) |
| `Tab` / `Shift+Tab`               | Indent / outdent                                                                                                |
| `Cmd/Ctrl+Shift+↑` / `↓`          | Move the bullet among siblings; at the edge reparent into the parent's adjacent sibling                         |
| `Cmd/Ctrl+↑` / `↓`                | Collapse / expand                                                                                               |
| `Cmd/Ctrl+Enter` or `Cmd/Ctrl+D`  | Toggle complete                                                                                                 |
| `Cmd/Ctrl+.` / `Cmd/Ctrl+,`       | Zoom in / out                                                                                                   |
| `Backspace` on an empty bullet    | Delete it and focus the previous one                                                                            |
| `Arrow ↑` / `↓` at line edges     | Move between bullets (preserves the caret column)                                                               |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` | Undo / redo                                                                                                     |
| `Cmd/Ctrl+K`                      | Open the quick-switcher                                                                                         |

Not built yet: sharing, email verification.

## Stack

| Layer      | Choice                                                       | Why                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework  | TanStack Start (SPA mode)                                    | File-based routing, no SSR needed for a local-first app                                                                                                                                                                                                                               |
| Data       | TanStack DB query collections over a per-user Durable Object | Optimistic mutations, schema-validated; the flat-row model swaps backends by changing collection options. Nodes use `/api/nodes`; plugin side data (tag colors, daily index) uses a generic `/api/kv` store ([the sync design](docs/adr/0008-sync-via-a-per-user-durable-object.md)). |
| Backend    | Cloudflare Worker + Durable Objects                          | One Worker serves the SPA and routes the `/api/nodes` + `/api/kv` sync APIs to a per-user Durable Object ([the auth gate](docs/adr/0011-the-auth-gate.md))                                                                                                                            |
| Auth       | Better Auth (email + password)                               | Invite-gated signup (alpha); its `user` table is the identity store and `user.id` keys each user's DO. Sessions in D1                                                                                                                                                                 |
| Validation | Effect Schema                                                | Standard-schema compatible (via `toStandardSchemaV1`), drives the collection's item type; one schema language across client + Worker                                                                                                                                                  |
| Build      | Vite 8                                                       | What Start uses                                                                                                                                                                                                                                                                       |
| Runtime    | Bun (dev/install)                                            | Fast; npm/pnpm/yarn work too                                                                                                                                                                                                                                                          |

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

The repo deploys to **Cloudflare Workers**: one Worker (`worker/index.ts`) serves the static SPA _and_ routes the `/api/nodes` + `/api/kv` sync APIs to a **per-user Durable Object**, behind **Better Auth** accounts ([the auth gate](docs/adr/0011-the-auth-gate.md)). Config is in `wrangler.jsonc`. Full design: [the sync design](docs/adr/0008-sync-via-a-per-user-durable-object.md).

```sh
bun install
bun run setup        # generates BETTER_AUTH_SECRET + applies the local D1 schema
bun run dev          # starts the app (vite :3000 + worker :8787) in one command
bun run seed:user    # (optional) creates dev@dotflowy.local / dotflowy-dev to sign in with

# or a production-like single-server preview
bun run cf:dev             # build + wrangler dev

# ship it
wrangler secret put BETTER_AUTH_SECRET   # once: the auth signing secret
wrangler secret put INVITE_CODES         # comma-separated invite codes (unset = signup closed)
bun run db:migrate:remote  # before the first deploy
bun run deploy             # build + wrangler deploy
```

The local invite code is **`dev-invite`** if you'd rather sign up your own account; `bun run seed:user` skips that by creating a ready-to-use account.

`build:cf` copies the TanStack Start shell (`_shell.html`) to `index.html` so the root and client routes (e.g. `/<nodeId>` zoom views) resolve through the SPA fallback.

**Auth.** Identity is **Better Auth** (email + password), sessions in D1. Signup is **invite-only during alpha**: creating an account requires a code from the `INVITE_CODES` secret (comma-separated; unset = signup closed), and the public `POST /api/waitlist` collects emails from anyone who wants in (viewable by admins — the `ADMIN_EMAILS` var — at `/admin/waitlist`). The static shell is public so the login screen loads; only `/api/nodes` + `/api/kv` require a session. Set `BETTER_AUTH_SECRET` (`wrangler secret put`) in prod and `.dev.vars` locally — without it the Worker fails closed. To carry a pre-auth outline (the constant `'default'` DO) into your real account, set the `OWNER_USER_ID` secret to your `user.id` after signing up. See [the auth gate](docs/adr/0011-the-auth-gate.md).

## How it works

### Data model

Every bullet is one row in a single TanStack DB collection. The outline tree is reconstructed in memory at read time.

```
Node {
  id, parentId, prevSiblingId,        // tree shape + sibling order
  text, isTask, completed, collapsed, // content + UI state
  kind,                               // null (a bullet, or a task per isTask) or "paragraph"
  bookmarkedAt,                       // null, or the ms it was pinned (also the bookmark sort key)
  mirrorOf,                           // null, or the id of the node this one windows
  origin,                             // null if you wrote it; the agent's name if MCP created it
  createdAt, updatedAt
}
```

A bullet, a to-do, and a paragraph are the three **kinds** of node — mutually exclusive presentations of the same thing, converted between but never combined. `completed` is orthogonal: any node can be done. See [paragraph nodes](docs/adr/0045-paragraph-node-kind.md).

Sibling order is a linked list via `prevSiblingId` (the Workflowy/Notion approach). Inserting between two bullets is O(1) and never requires renumbering. Reordering is relinking pointers.

See `src/data/tree.ts` for the index builder and `src/data/mutations.ts` for the structural operations — insert, indent / outdent, the fused `moveNode` (drag reorder + reparent), move up / down, delete — plus the field setters (text, task, completed, collapsed, bookmark). Each preserves the linked-list invariant.

### Why flat, not nested

A flat list of rows maps cleanly onto a sync backend. Nested JSON would force deep-merge on every keystroke. Flat rows keep moves cheap and made each backend move (localStorage → D1 → a per-user Durable Object) a `nodes` table swap, not a rewrite.

### Persistence

`nodesCollection` (`src/data/collection.ts`) is a TanStack DB **query collection**: the `queryFn` GETs the full node set from `/api/nodes` and the mutation handlers POST/PATCH/DELETE through the same Worker, which **routes each request to the caller's Durable Object** and reads/writes the `nodes` table in its colocated SQLite. We mutate directly (`collection.insert / update / delete`); writes are optimistic locally and persisted server-side, reconciling across devices on tab focus. See [the sync design](docs/adr/0008-sync-via-a-per-user-durable-object.md).

Plugin **side-collections** (tag colors, the daily index) sync the same way, over a generic `/api/kv` store (one `kv` table in the same DO, namespaced by collection) — so a custom tag color or a daily-note follows you across devices too. See [the sync design](docs/adr/0008-sync-via-a-per-user-durable-object.md).

### Plugins

The editor is a small core extended by **plugins** compiled into the bundle (an internal registry, not runtime-loaded). `code`, `links`, `tags`, and `todos` are each a plugin built on the same public API, so the core carries no feature-specific branches. A plugin registers against a fixed set of _seams_ — inline tokens, delegated clicks, `/` commands, keymap, row slots, view transforms, autocomplete menus, paste / autoformat, and side-collections. Adding a feature is a folder under `src/plugins/<name>/` plus one line in `src/plugins/index.ts`. See [the plugin architecture](docs/adr/0001-plugin-architecture.md).

## Sync: where it stands

The collection interface is backend-agnostic — that's how moving the backend (localStorage → D1 → a per-user Durable Object) touched only `collection.ts` and the Worker, leaving every component and the tree logic unchanged.

Today, **nodes sync live** over a per-user WebSocket (`/api/sync`): optimistic writes still POST/PATCH/DELETE `/api/nodes`, and the DO broadcasts deltas to every connected tab/device. **Side-collections** (tag colors, daily index) still reconcile on tab focus (`refetchOnWindowFocus`). Not yet built:

- **Sharing** — a node + subtree shared with another user (a future "mount" pointer; see [the sync design](docs/adr/0008-sync-via-a-per-user-durable-object.md)).

A returning owner's pre-DO outline is carried over **server-side**: the Worker does a one-time, non-destructive copy of any pre-DO D1 rows into the owner's Durable Object on first `/api/sync` connect (`ensureSeeded`). There is no client-side `localStorage` migration — localStorage is browser-scoped but accounts are per-user, so importing it would leak one browser's leftover outline into every new account that signed in there.

See [the sync design](docs/adr/0008-sync-via-a-per-user-durable-object.md) for the design and rejected alternatives (incl. why a Durable Object over D1-direct or ElectricSQL).

## Agents (MCP)

The outline is also reachable by AI agents over the [Model Context Protocol](https://modelcontextprotocol.io): point an MCP client at `https://<your-deployment>/mcp` and it walks the standard OAuth flow (sign in with your normal account; the client registers itself). Agents get read tools (`get_outline`, `search_nodes`, `export_opml`) and write tools (`add_node`, `add_subtree`, `update_node`, `delete_node`, `move_nodes`, `add_to_today`, `mirror_node`, `mirror_to_today`, `import_opml`); every write lands through the same atomic per-user Durable Object path as the editor, so open tabs see agent edits live. Design + rejected alternatives: [the agent-native MCP server](docs/adr/0026-agent-native-mcp-server.md).

The OPML pair speaks the Workflowy dialect through the same shared core as the app's own import/export ([ADR 0037](docs/adr/0037-opml-import-export.md)): `import_opml` takes an OPML string (targeted like `add_subtree` — `parentId`, `date`, or the top level), lands it as one atomic batch with the agent's provenance stamp, and answers with a compact receipt (root ids, counts, the fidelity-degradation tally) — `dryRun: true` previews that receipt without writing; `export_opml` mirrors `get_outline` scoping and returns the raw OPML string. Both are capped at 5,000 nodes and reject rather than truncate — a full Workflowy migration belongs in the app UI.

## Project layout

```
src/
  routes/
    __root.tsx        # HTML shell, global CSS, app-wide providers
    index.tsx         # the outline at the top level (Home)
    $nodeId.tsx       # the same outline zoomed into one bullet
  lib/
    auth-client.ts    # Better Auth browser client (useSession / signIn / signUp / signOut / signOutAndReload)
    utils.ts          # cn() and small helpers
  components/
    auth-screen.tsx     # login / signup screen (shown by the root AuthGate when signed out)
    # sign out lives in the header More menu (header-more-menu.tsx) and the Cmd+K command center (command-actions.tsx)
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
    schema.ts         # Effect Schema, Node type
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
  plugins/            # the editor's plugin layer (see docs/adr/0001-plugin-architecture.md)
    index.ts          # the one ordered array: [code, links, tags, todos, daily]
    types.ts          # the typed seam contract (definePlugin)
    registry.ts       # composes every plugin's registrations once at load
    code/ links/ tags/ todos/ daily/   # one folder per plugin
  router.tsx
  styles.css
worker/               # Cloudflare Worker: serves the SPA + routes /api/nodes + /api/kv to per-user DOs
  index.ts            #   session gate + resolveUserId + routes /api to the user's DO (own tsconfig)
  auth.ts             #   createAuth(env): Better Auth (email + password + the MCP OAuth provider), sessions in D1
  outline-do.ts       #   UserOutlineDO: per-user SQLite (nodes + kv), the outline store
  mcp.ts              #   the MCP endpoint: stateless JSON-RPC over /mcp (Effect pipeline)
  mcp-tools.ts        #   the MCP tool registry (Effect Schema inputs + handlers over the user's DO)
  outline-ops.ts      #   pure server-side outline planners (snapshot -> atomic ChangeOp batch)
migrations/           # D1 SQL migrations (0001 nodes, 0002 kv = DO import source; 0003 Better Auth; 0004 OAuth/MCP)
wrangler.jsonc        # Worker + assets + Durable Object + D1 bindings (+ nodejs_compat)
docs/adr/             # one ADR per load-bearing decision (history in git log)
vite.config.ts        # SPA mode + /api dev proxy
```

## Contributing

Setup, the local dev loops, the pre-PR check matrix, and repo conventions live in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). Agent-facing rules are in
[`AGENTS.md`](./AGENTS.md).

## License

Copyright © FAITH TOOLS SOFTWARE SOLUTIONS, LLC. Released under the [O'Saasy License](./LICENSE). Source is available for learning, modification, and self-hosting; offering a competing hosted SaaS product is reserved to the copyright holder.
