# Architecture

How Dotflowy stores, syncs, and renders an outline. This is the human-facing
overview; per-feature rules and gotchas live in [`AGENTS.md`](../AGENTS.md), and
each load-bearing decision has a full write-up in [`docs/adr/`](./adr/).

## The shape of the system

Your outline is stored in a TanStack DB collection. By default that's backed by
a per-user **Cloudflare Durable Object** (its colocated SQLite) through a
Worker — writes go to `/api/nodes`, live reads over `/api/sync` (WebSocket) —
so edits show up on your other tabs/devices without refocusing. See
[the sync design](./adr/0008-sync-via-a-per-user-durable-object.md). The
flat-row data model means swapping the backend is a collection-options change,
not a rewrite.

## Data model

Every bullet is one row in a single TanStack DB collection. The outline tree is
reconstructed in memory at read time.

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

A bullet, a to-do, and a paragraph are the three **kinds** of node — mutually
exclusive presentations of the same thing, converted between but never
combined. `completed` is orthogonal: any node can be done. See
[paragraph nodes](./adr/0045-paragraph-node-kind.md).

Sibling order is a linked list via `prevSiblingId` (the Workflowy/Notion
approach). Inserting between two bullets is O(1) and never requires
renumbering. Reordering is relinking pointers.

See `src/data/tree.ts` for the index builder and `src/data/mutations.ts` for
the structural operations — insert, indent / outdent, the fused `moveNode`
(drag reorder + reparent), move up / down, delete — plus the field setters
(text, task, completed, collapsed, bookmark). Each preserves the linked-list
invariant.

### Why flat, not nested

A flat list of rows maps cleanly onto a sync backend. Nested JSON would force
deep-merge on every keystroke. Flat rows keep moves cheap and made each backend
move (localStorage → D1 → a per-user Durable Object) a `nodes` table swap, not
a rewrite.

## Persistence and sync

`nodesCollection` (`src/data/collection.ts`) is a TanStack DB **custom sync
collection**: on connect, the Worker **routes `/api/sync` to the caller's
Durable Object**, which streams a `snapshot` of the outline and then live
`change` deltas over the WebSocket — no window-focus refetch. Writes are
optimistic locally (`collection.insert / update / delete`) and persist through
the same Worker into the DO's colocated SQLite: field edits (text, completed,
…) PATCH `/api/nodes` directly, while structural edits (insert / move /
delete) land as **one atomic batch** (`POST /api/nodes {ops}`) whose optimistic
overlay is held until the socket echoes the committed change. See
[the sync design](./adr/0008-sync-via-a-per-user-durable-object.md) and
[atomic structural writes](./adr/0009-atomic-structural-writes.md).

Plugin **side-collections** (tag colors, the daily index, the changelog
cursor) are query collections over a generic `/api/kv` store (one `kv` table
in the same DO, namespaced by collection), reconciling on tab focus — so a
custom tag color or a daily note follows you across devices too.

### Where sync stands

The collection interface is backend-agnostic — that's how moving the backend
(localStorage → D1 → a per-user Durable Object) touched only `collection.ts`
and the Worker, leaving every component and the tree logic unchanged.

Today, **nodes sync live** over a per-user WebSocket (`/api/sync`): optimistic
writes still POST/PATCH/DELETE `/api/nodes`, and the DO broadcasts deltas to
every connected tab/device. **Side-collections** (tag colors, daily index)
still reconcile on tab focus (`refetchOnWindowFocus`). Not yet built:

- **Sharing** — a node + subtree shared with another user (a future "mount"
  pointer; see [the sync design](./adr/0008-sync-via-a-per-user-durable-object.md)).

A returning owner's pre-DO outline is carried over **server-side**: the Worker
does a one-time, non-destructive copy of any pre-DO D1 rows into the owner's
Durable Object on first `/api/sync` connect (`ensureSeeded`). There is no
client-side `localStorage` migration — localStorage is browser-scoped but
accounts are per-user, so importing it would leak one browser's leftover
outline into every new account that signed in there.

See [the sync design](./adr/0008-sync-via-a-per-user-durable-object.md) for the
design and rejected alternatives (incl. why a Durable Object over D1-direct or
ElectricSQL).

## Plugins

The editor is a small core extended by **plugins** compiled into the bundle (an
internal registry, not runtime-loaded). `code`, `links`, `node-links`,
`route-bible`, `tags`, `todos`, `daily`, `emphasis`, `highlight`, `spoiler`,
and `provenance` are each a plugin built on the same public API, so the core
carries no feature-specific branches. A plugin registers against a fixed set of
_seams_ — inline tokens, delegated clicks, `/` commands, keymap, row slots,
view transforms, autocomplete menus, paste / autoformat, and side-collections.
Adding a feature is a folder under `src/plugins/<name>/` plus one line in
`src/plugins/index.ts`. See
[the plugin architecture](./adr/0001-plugin-architecture.md).

## Stack

| Layer         | Choice                                                 | Why                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework     | TanStack Start (SPA mode)                              | File-based routing, no SSR needed for a local-first app                                                                                                                                                                                                                                                                                                                       |
| Data          | TanStack DB collections over a per-user Durable Object | Optimistic mutations, schema-validated; the flat-row model swaps backends by changing collection options. Nodes ride a custom sync collection (live `/api/sync` WebSocket, writes via `/api/nodes`); plugin side data (tag colors, daily index) rides query collections over a generic `/api/kv` store ([the sync design](./adr/0008-sync-via-a-per-user-durable-object.md)). |
| Backend       | Cloudflare Worker + Durable Objects                    | One Worker serves the SPA and routes the `/api/nodes` + `/api/kv` sync APIs to a per-user Durable Object ([the auth gate](./adr/0011-the-auth-gate.md))                                                                                                                                                                                                                       |
| Auth          | Better Auth (email + password)                         | Its `user` table is the identity store and `user.id` keys each user's DO. Sessions in D1                                                                                                                                                                                                                                                                                      |
| Validation    | Effect Schema                                          | Standard-schema compatible (via `toStandardSchemaV1`), drives the collection's item type; one schema language across client + Worker                                                                                                                                                                                                                                          |
| Build         | Vite 8                                                 | What Start uses                                                                                                                                                                                                                                                                                                                                                               |
| Runtime       | Bun (dev/install)                                      | Fast; npm/pnpm/yarn work too                                                                                                                                                                                                                                                                                                                                                  |
| Observability | Sentry (errors-only)                                   | Exception capture across the client, Worker, and DO — **no tracing, APM, or replay**, just errors. Gives contributors a real stack trace when something throws in prod. DSN is public-by-design (committed in `.env.production` + `wrangler.jsonc`, not a secret); unset in a fork = dormant, nothing phones home. Outline node text never rides an error payload.            |

## Project layout

```
src/
  routes/
    __root.tsx        # HTML shell, global CSS, app-wide providers
    index.tsx         # the outline at the top level (Home)
    $nodeId.tsx       # the same outline zoomed into one bullet
  lib/
    auth-client.ts    # Better Auth browser client (useSession / signIn / signUp / signOutAndReload — sign-out always hard-navigates)
    utils.ts          # cn() and small helpers
  components/
    auth-screen.tsx     # login / signup screen (shown by the root AuthGate when signed out)
    # sign out lives in the header More menu (header-more-menu.tsx) and the Cmd+K command center (command-actions.tsx)
    OutlineEditor.tsx   # reads tree, focus + command dispatch, the zoom view
    OutlineRow.tsx      # the outline row (flat windowed list — virtualized rendering)
    inline-code.ts      # contentEditable decorate / caret engine (source-offset aware)
    menu-engine.tsx     # generic caret-autocomplete engine
    slash-menu.tsx      # the `/` command palette
    node-switcher.tsx   # Cmd+K quick-switcher
    move-dialog.tsx     # the `/move` destination picker
    bookmarks.tsx       # the header star (browsing lives in the Cmd+K empty state)
    use-drag-reorder.ts # bullet-dot drag (reorder + reparent)
    Header.tsx, paste.ts, flash-node.ts, *-provider.tsx, *-toggle.tsx, ui/
  data/
    schema.ts         # Effect Schema, Node type
    wire-schema.ts    # shared wire schemas (one leaf imported by client + Worker)
    collection.ts     # TanStack DB custom sync collection (live /api/sync + /api/nodes writes)
    realtime.ts       # the sync socket as an Effect scoped resource
    structural.ts     # runStructural: atomic structural batches + echo hold
    api.ts            # REST client for the /api/nodes Worker
    kv-api.ts         # REST client for the generic /api/kv side-collection store
    query-client.ts   # shared TanStack Query client (focus refetch = sync)
    tree.ts           # flat-list -> TreeIndex, trail / id / time helpers
    tree-store.ts     # per-node subscriptions (useNode / useVisibleChildIds)
    mutations.ts      # insert / move / delete / field setters
    history.ts        # undo / redo capture
    tags.ts, tag-colors.ts, links.ts  # pure parsing + the tag-color side-collection (synced via /api/kv)
    seed.ts           # first-run bootstrap: seed welcome bullets when the outline is empty
    sentry-scrub.ts   # shared scrub leaf: strip node text / ?q= from error payloads (client + Worker)
    useTree.ts        # useLiveQuery hook
  plugins/            # the editor's plugin layer (see docs/adr/0001-plugin-architecture.md)
    index.ts          # the one ordered array (todos, provenance, code, links, node-links, …)
    types.ts          # the typed seam contract (definePlugin)
    registry.ts       # composes every plugin's registrations once at load
    code/ links/ node-links/ route-bible/ tags/ todos/ daily/
    emphasis/ highlight/ spoiler/ provenance/   # one folder per plugin
  instrument.client.ts # Sentry init (errors-only), imported first in __root.tsx; no-op in dev/prerender
  router.tsx
  styles.css
worker/               # Cloudflare Worker: serves the SPA + routes /api/nodes + /api/kv to per-user DOs
  index.ts            #   session gate + resolveUserId + routes /api to the user's DO (own tsconfig)
  wire.ts             #   request-body schemas: the validated Worker->DO trust boundary
  auth.ts             #   createAuth(env): Better Auth (email + password + the MCP OAuth provider), sessions in D1
  outline-do.ts       #   UserOutlineDO: per-user SQLite (nodes + kv), the outline store
  mcp.ts              #   the MCP endpoint: stateless JSON-RPC over /mcp (Effect pipeline)
  mcp-tools.ts        #   the MCP tool registry (Effect Schema inputs + handlers over the user's DO)
  outline-ops.ts      #   pure server-side outline planners (snapshot -> atomic ChangeOp batch)
  sentry.ts           #   errors-only Sentry options for the Worker + DO (dormant when SENTRY_DSN is unset)
migrations/           # D1 SQL migrations (0001 nodes, 0002 kv = DO import source; 0003 Better Auth; 0004 OAuth/MCP; 0005 waitlist)
wrangler.jsonc        # Worker + assets + Durable Object + D1 bindings (+ nodejs_compat)
docs/adr/             # one ADR per load-bearing decision (history in git log)
vite.config.ts        # SPA mode + /api dev proxy
```
