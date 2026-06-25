# Dotflowy OSS

An open-source outline editor in the spirit of [Workflowy](https://workflowy.com). Built with [Wasp](https://wasp.sh) (React + Node + Prisma), [TanStack DB](https://tanstack.com/db) on the client, and PostgreSQL on the server.

**Online-first v1:** edits sync optimistically to Postgres through Wasp queries/actions; the collection re-pulls on tab focus. Full offline-first (OPFS + outbox) is planned for v1.1 — see [`docs/PRD-wasp-migration.md`](docs/PRD-wasp-migration.md).

## Status

Each signed-in user gets a **private silo** of outline data in PostgreSQL. The editor is a TanStack DB collection mirror (`nodesCollection`) hydrated by `getNodes` and persisted through Wasp actions — the same flat-row model as before, so tree logic and components stayed unchanged through the Cloudflare → Wasp migration.

What works:

- Email/password accounts (sign up, log in, per-user data)
- Nested bullets with inline editing; collapse / expand subtrees (hover chevron in the gutter)
- Zoom into any bullet as a temporary root (click its dot), with a breadcrumb trail back out
- Tasks: a checkbox marks complete; a "show completed" toggle hides done items
- Drag the bullet dot to reorder **and** reparent in one drop (mouse + touch)
- Markdown-style rich text: `inline code`, `[links](https://…)` that fold to a clean label, and `#tags`
- Clicking a `#tag` filters the outline in place; right-click a tag to color it
- Bookmarks (the header star pins the current zoom view) and a `Cmd/Ctrl+K` quick-switcher to jump anywhere
- A `/` command palette (to-do, plain bullet, move) and a move-to dialog
- Daily notes, scripture reference chips (route.bible), dark mode, undo / redo

Not built yet: sharing/collaboration, real-time push (sync reconciles on tab focus), offline queue (v1.1).

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

## Stack

| Layer | Choice | Why |
|---|---|---|
| Full stack | [Wasp](https://wasp.sh) 0.24 (TS spec) | Auth, Prisma, queries/actions, deploy tooling |
| Client data | TanStack DB query collections | Optimistic local mirror; keystrokes never wait on the network |
| Server data | PostgreSQL (Railway in prod) | Multi-user silos, typed plugin tables |
| Validation | Zod 4 | Drives collection item types |
| Runtime | Node 24 (Wasp server), Bun (install/scripts) | Wasp requires Node for dev/deploy |

## Run it

**Prerequisites:** Node 24+, Bun, Docker (optional — for `wasp start db`).

```sh
bun install
cp .env.server.example .env.server   # set DATABASE_URL; see file for dev flags
wasp start db                        # first time: local Postgres in Docker
wasp start                           # client :3000, server :3001
```

Sign up at `/signup`. With `SKIP_EMAIL_VERIFICATION_IN_DEV=true` in `.env.server`, you can log in immediately (verification links print to the server log otherwise).

Other useful scripts:

```sh
wasp compile       # after changing main.wasp.ts, *.wasp.ts, or schema.prisma
bun run typecheck  # tsc -b tsconfig.src.json
bun run test:e2e   # Playwright (chromium) against wasp start
```

## Deploy (Railway)

Production target is **Railway** (Wasp app + managed Postgres). One-time setup:

```sh
wasp deploy railway launch
```

Subsequent releases:

```sh
wasp deploy railway deploy
```

Wasp sets `DATABASE_URL`, `JWT_SECRET`, and client/server URLs on deploy. Prisma migrations in `migrations/` apply automatically on server start. Configure a real email provider in `main.wasp.ts` before inviting users (dev uses the Dummy sender).

See the [Wasp Railway deploy docs](https://wasp.sh/docs/deployment/deployment-methods/paas) and [`docs/PRD-wasp-migration.md`](docs/PRD-wasp-migration.md) for the migration rationale.

## Founder data migration (D1 → Postgres)

The pre-Wasp deployment used Cloudflare D1. To import that outline into your Wasp account:

```sh
# 1. Export remote D1 once (needs wrangler login; see cloudflare-legacy/README.md)
bash scripts/export-d1.sh backups/d1-export.json

# 2. Sign up on the target environment, then import into your user
wasp compile
bun scripts/import-d1-export.ts \
  --file backups/d1-export.json \
  --owner owner \
  --user-email you@example.com
```

Legacy `owner` keys (`owner`, Access email, `local-dev`) map to your Wasp `User.id` via `--user-email` or `--user-id`. Re-run requires `--force` (destructive). Export JSON stays local under `backups/` (gitignored).

## How it works

### Data model

Every bullet is one row. The outline tree is reconstructed in memory at read time.

```
Node {
  id, parentId, prevSiblingId,        // tree shape + sibling order
  text, isTask, completed, collapsed, // content + UI state
  bookmarkedAt,                       // null, or the ms it was pinned
  createdAt, updatedAt                // epoch-ms on the client; DateTime in Postgres
}
```

Sibling order is a linked list via `prevSiblingId`. See `src/data/tree.ts` and `src/data/mutations.ts`.

### Persistence

`nodesCollection` (`src/data/collection.ts`) is a TanStack DB **query collection**: `queryFn` calls Wasp `getNodes`; mutation handlers call `upsertNodes` / `updateNodes` / `deleteNodes` (`src/data/api.ts` → `src/nodes/operations.ts`). Writes are optimistic locally with `{ refetch: false }`; cross-device edits reconcile on window-focus refetch (`src/data/query-client.ts`).

Plugin **side-collections** (tag colors, daily index) use typed Prisma tables and their own Wasp operations (`src/plugins/tags/`, `src/plugins/daily/`).

### Plugins

The editor core is extended by compiled-in plugins under `src/plugins/`. See [the plugin architecture](docs/DECISIONS.md#plugin-architecture).

## Sync: where it stands

**v1 (today):** online-first, reconcile-on-focus, last-write-wins via server `updatedAt`. **v1.1 (planned):** OPFS SQLite cache + offline transaction outbox.

A returning user's pre-D1 browser outline is still **imported from localStorage once** on first load against an empty server (`src/data/import-legacy.ts`).

Historical Cloudflare Worker + D1 design (superseded): [docs/DECISIONS.md#d1-sync-via-a-worker](docs/DECISIONS.md#d1-sync-via-a-worker).

## Project layout

```
main.wasp.ts          # Wasp app spec (routes, auth, operation slices)
schema.prisma         # User, Node, TagColor, DailyIndexEntry
migrations/           # Prisma SQL migrations
src/
  app/                # Wasp pages (OutlinePage, auth)
  components/         # OutlineEditor, OutlineNode, menus, header, …
  data/               # schema, collection, api (Wasp op wrappers), tree, mutations, …
  nodes/              # getNodes / upsertNodes / … (Wasp server ops)
  plugins/            # code, links, tags, todos, daily, route-bible (+ *.wasp.ts slices)
  account/            # deleteAccount
scripts/              # D1 export/import (Phase 4 cutover)
cloudflare-legacy/    # old D1 SQL + export-only wrangler config
docs/                 # PRD, DECISIONS
e2e/                  # Playwright specs
```

## License

MIT. See [LICENSE](./LICENSE).
