# PRD: Dotflowy Platform Migration (Cloudflare → Wasp + Railway)

**Status:** v1 complete (Phases 1–4 shipped on `wasp` branch); v1.1 offline-first next  
**Author:** Cameron Pak + agent session  
**Last updated:** 2026-06-25  
**Repo:** Same repo (`dotflowy`) — in-place restructure  

---

## 1. Executive Summary

### Problem Statement

Dotflowy is a local-first outline editor currently deployed as a single-user Cloudflare Worker + D1 stack with HTTP Basic Auth / Cloudflare Access. The product roadmap requires **multi-user accounts**, **offline-first sync** (v1.1), and a maintainable full-stack foundation — without sacrificing the editor's sub-frame typing performance or zoom view transitions. The Cloudflare stack was the right v1 deployment target; it is not the right long-term platform for auth, Postgres, or modular plugin growth.

### Proposed Solution

Migrate Dotflowy to **Wasp** (TS spec + React + Node/Express + Prisma) deployed on **Railway** with **PostgreSQL**. Use **Wasp defaults on the server**: Prisma entities, **queries** for reads, **actions** for writes, email/password auth, and vertical-slice `*.wasp.ts` specs per plugin. On the client, keep **TanStack DB collections** as the optimistic local mirror (`tree-store`, `mutations`, plugins unchanged); the sync boundary calls Wasp operations instead of REST. **v1 ships online-first** (same reconcile-on-focus sync model as today). Replace the generic `/api/kv` store with **typed Prisma models per plugin**. Launch with **private per-user silos**; `Node.visibility` defaults to `private` with hooks for public/sharing in a later release.

**v1.1** adds full offline-first: OPFS SQLite persistence + offline transaction outbox wrapping Wasp actions (US-3).

### Success Criteria (v1 launch)

| KPI | Target | Measurement |
|-----|--------|-------------|
| **Keystroke-to-paint latency** | ≤ 16 ms (one frame at 60 Hz) for text edits on a 1,000-node outline | Playwright + `performance.now()` instrumentation on `nodesCollection.update` → DOM commit |
| **Cold open (online)** | App interactive within 2 s on repeat visit (warm session, network available) | Manual: login → `getNodes` hydrate → first editable bullet focused |
| **Full sync load** | Initial query + tree build ≤ 2 s for 5,000 nodes on desktop broadband | Server timing + client `getNodes` → collection hydrate → `toArrayWhenReady` |
| **Data migration** | 100% of existing D1 nodes + plugin side-data imported into founder account | Seed script diff: D1 export row count === Postgres row count |
| **Regression gate** | Existing Playwright e2e suite passes against Wasp dev server | `bun run test:e2e` green |
| **Zoom transitions** | View Transition morph preserved on dot-click zoom in/out | Manual QA checklist + optional `startViewTransition` assertion in e2e |

---

## 2. User Experience & Functionality

### User Personas

| Persona | Description | v1 scope |
|---------|-------------|----------|
| **Founder (Cameron)** | Original single-user; has existing D1 outline data to migrate | Primary launch user; seed script target |
| **Registered user** | Signs up with email/password; builds private outlines | v1 — full editor, private silo only |
| **Future collaborator** | Invited to read/edit shared subtrees or public nodes | Out of v1; schema reserved |

### User Stories (v1)

#### US-1: Account creation and sign-in

**As a** new user, **I want to** create an account with email and password **so that** my outline is private and synced to my identity.

**Acceptance criteria:**
- Wasp username/password auth enabled; no OAuth in v1.
- Every query/action scoped to authenticated `context.user.id`; unauthenticated calls receive 401.
- User A cannot read, write, or delete User B's nodes or plugin data.
- Session persists across browser restarts (Wasp default JWT/session behavior).
- Bootstrap (`seedIfEmpty`) runs **per userId** — module-scoped guards reset on auth change (login/logout/switch user).
- Account deletion cascades to all user nodes and plugin rows (Wasp hook + Prisma `onDelete: Cascade`).

#### US-2: Edit outline with existing editor UX

**As a** signed-in user, **I want to** use the full Dotflowy editor (bullets, zoom, tasks, tags, links, daily notes, plugins) **so that** the migration changes nothing about how I work.

**Acceptance criteria:**
- All features listed in README "What works" remain functional post-migration.
- Keystroke latency meets KPI (≤ 16 ms local paint).
- Zoom view transitions (dot-click morph) preserved; `prefers-reduced-motion` respected.
- Undo/redo, drag-reorder, Cmd+K switcher, bookmarks, tag filter (`?q=`), and plugin seams unchanged in behavior.
- Undo/redo stack remains **session-local** (in-memory snapshots, not synced to server).

#### US-4: Sync across devices

**As a** user signed in on two devices, **I want to** see edits from the other device **so that** my outline stays consistent.

**Acceptance criteria:**
- Tab focus triggers full-node-set refetch via `getNodes` (existing `refetchOnWindowFocus` behavior preserved).
- Conflict resolution: **last-write-wins** — server applies updates only when client `updatedAt >= row.updatedAt`; stale writes dropped silently; **server sets `updatedAt` on successful apply** (authoritative timestamp).
- Network loss during edit: mutation fails; user sees error or retry on reconnect (no offline queue in v1).

#### US-5: Founder data migration

**As the** founder, **I want to** one-time import my existing D1 outline **so that** I don't lose my data at cutover.

**Acceptance criteria:**
- Dev-only script: export D1 → JSON file → import into specified Wasp `User.id`.
- Maps legacy `owner` (Access email / `'owner'`) → Wasp `User.id`.
- Not exposed as in-app "import backup" UI in v1.
- Import is idempotent or guarded (re-run does not duplicate nodes).

#### US-6: Plugin data syncs per-plugin

**As a** user, **I want to** tag colors and daily-note identity to follow me across devices **so that** plugin features feel as reliable as the core outline.

**Acceptance criteria:**
- `TagColor` and `DailyIndexEntry` stored in typed Prisma tables (not generic KV).
- Each plugin owns Wasp query/action declarations in its `*.wasp.ts` slice.
- TanStack DB side-collections on client call plugin Wasp actions (same mirror pattern as nodes).

### Deferred to v1.1

#### US-3: Work offline

**As a** user, **I want to** read and edit my outline without network **so that** I can work on planes, in tunnels, or during outages.

**Acceptance criteria (v1.1):**
- After at least one successful sync, app opens and is editable with network disabled (OPFS cache).
- Edits queue in offline outbox (`@tanstack/offline-transactions`); UI updates optimistically immediately.
- On reconnect, outbox replays Wasp actions automatically with exponential backoff.
- Pending mutations survive tab close and browser restart (IndexedDB outbox + OPFS cache).
- Multi-tab: `BrowserCollectionCoordinator` prevents SQLite corruption; one leader processes outbox.
- OPFS unavailable (Safari private mode): degrade to online-only with a toast warning.
- Idempotency keys in action args prevent duplicate rows on offline replay retry.

### Non-Goals (v1)

- **Offline-first** — OPFS persistence, offline outbox, multi-tab coordinator (v1.1 / US-3).
- **Sharing / collaboration** — no invites, no shared subtrees, no public URLs (`Node.visibility` stubbed; no UI).
- **Real-time push / WebSockets** — sync remains reconcile-on-focus.
- **OAuth providers** (Google, GitHub) — email/password only at launch.
- **Wasp Full-Stack Modules (npm packages)** — structure like FSMs; do not block on experimental FSM packaging.
- **Lazy subtree loading / pagination** — load-all tree model retained.
- **Conflict UI** — silent LWW; no merge dialog or 409 surfacing to user in v1.
- **Parallel Cloudflare run** — big-bang cutover; Worker/D1/wrangler deleted after launch.
- **In-app legacy import UI** — D1 → seed script only.
- **Custom REST `api()` handlers** — use Wasp queries/actions, not a port of `worker/index.ts` REST shape.
- **Full client rewrite to `useQuery`/`useAction`** — TanStack DB collections remain the editor's local source of truth; Wasp hooks hydrate and persist at the sync boundary only.

---

## 3. AI System Requirements

**Not applicable.** This migration has no LLM, agent, or AI-inference components.

---

## 4. Technical Specifications

### Architecture Overview

**Pattern: Wasp-defaults server, TanStack DB client mirror (Option A). v1 = online-first.**

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (SPA) — v1                                             │
│  ┌──────────────┐  ┌─────────────────┐                          │
│  │ React Editor │→ │ TanStack DB     │  (in-memory; v1.1 +OPFS) │
│  │ + plugins    │  │ collections     │                          │
│  │              │  │ (local mirror)  │                          │
│  └──────────────┘  └────────┬────────┘                          │
│                             │ Wasp client ops (same-origin)     │
│                    ┌────────▼────────┐                          │
│                    │ Sync boundary   │ getNodes → hydrate      │
│                    │ (api.ts repl.)  │ actions → onInsert/Update │
│                    └────────┬────────┘                          │
└─────────────────────────────┼───────────────────────────────────┘
                              │ Wasp queries + actions (RPC)
┌─────────────────────────────▼───────────────────────────────────┐
│  Wasp Server (Node/Express on Railway)                          │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │ Wasp auth    │  │ Core ops        │  │ Plugin ops         │  │
│  │ (email/pass) │  │ getNodes        │  │ getTagColors       │  │
│  └──────────────┘  │ upsertNodes     │  │ upsertTagColors    │  │
│                    │ updateNodes     │  │ getDailyIndex      │  │
│                    │ deleteNodes     │  │ upsertDailyIndex   │  │
│                    └────────┬────────┘  └─────────┬──────────┘  │
│                    ┌────────▼─────────────────────▼──────────┐  │
│                    │ Prisma → PostgreSQL (Railway)           │  │
│                    │ User, Node, TagColor, DailyIndexEntry   │  │
│                    └─────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

v1.1 adds: OPFS SQLite (persistedCollectionOptions) + offline executor
            (IndexedDB outbox → replays Wasp actions on reconnect)
```

**Data flow (v1 happy path):**
1. Login → Wasp session JWT.
2. `getNodes` query → hydrate TanStack DB collection.
3. Keystroke → `nodesCollection.update` (sync, local) → tree-store re-renders one bullet.
4. Background → collection `onUpdate` calls `updateNodes` action with `{ refetch: false }`.
5. Tab focus → refetch `getNodes` → reconcile collection with server.

### Integration Points

| Integration | Detail |
|-------------|--------|
| **Wasp TS spec** | `main.wasp.ts` + per-plugin `*.wasp.ts` slices (routes, auth, entities, queries, actions) |
| **Database** | PostgreSQL on Railway; Prisma migrations replace D1 SQL migrations |
| **Auth** | Wasp username/password; `context.user.id` scopes all queries/actions |
| **Client routing** | TanStack Router → React Router 7 (Wasp pages); preserve `location.state.pivotId` + `viewTransition` |
| **Server data layer** | Wasp queries/actions (not custom REST `api()` handlers) |
| **Client data layer** | TanStack DB collections unchanged; sync boundary calls Wasp client operations |
| **TanStack DB (v1)** | `@tanstack/react-db`, `@tanstack/query-db-collection` |
| **TanStack DB (v1.1)** | + `@tanstack/browser-db-sqlite-persistence`, `@tanstack/offline-transactions` |
| **Deploy** | Railway (app + Postgres); remove `wrangler`, `worker/`, Cloudflare bindings |
| **E2e** | Playwright against Wasp dev server; auth fixture + operation mocks or real DB |

### Data Model (Prisma)

**Core — `Node`** (mirrors existing `src/data/schema.ts`; `owner` → `userId`):

```
Node {
  id, userId, parentId, prevSiblingId,
  text, isTask, completed, collapsed,
  bookmarkedAt, visibility (enum, default 'private'),
  createdAt, updatedAt
}
```

Indexes: `(userId)`, `(userId, parentId)`.

**Plugin — `TagColor`:**
```
TagColor { userId, tag (normalized), color, updatedAt }
PK: (userId, tag)
```

**Plugin — `DailyIndexEntry`:**
```
DailyIndexEntry { userId, key (YYYY-MM-DD | "container"), nodeId }
PK: (userId, key)
FK: nodeId → Node (onDelete: SetNull or Cascade — TBD; daily container is protected)
```

**Sharing (v1 stub, unused):**
- `Node.visibility: 'private' | 'public'` — default `private`. No UI in v1.
- `NodeShare` join table deferred to pre-sharing PRD (v2.0).

### Wasp Operations (replaces REST API contract)

#### Core — nodes

| Operation | Type | Args | Behavior |
|-----------|------|------|----------|
| `getNodes` | query | — | Return all nodes for `context.user.id` |
| `upsertNodes` | action | `{ nodes: Node[] }` | Upsert batch; scoped to userId |
| `updateNodes` | action | `{ updates: { id, changes }[] }` | LWW: apply only if `changes.updatedAt >= row.updatedAt`; set server `updatedAt` on success |
| `deleteNodes` | action | `{ ids: string[] }` | Delete where `id` AND `userId` match |

#### Plugin — tags (`src/plugins/tags/tags.wasp.ts`)

| Operation | Type | Args | Behavior |
|-----------|------|------|----------|
| `getTagColors` | query | — | All tag colors for user |
| `upsertTagColors` | action | `{ rows: TagColor[] }` | Upsert by `(userId, tag)` |

#### Plugin — daily (`src/plugins/daily/daily.wasp.ts`)

| Operation | Type | Args | Behavior |
|-----------|------|------|----------|
| `getDailyIndex` | query | — | All daily index entries for user |
| `upsertDailyIndex` | action | `{ rows: DailyIndexEntry[] }` | Upsert by `(userId, key)` |
| `deleteDailyIndexKeys` | action | `{ keys: string[] }` | Delete scoped rows |

**LWW semantics:** Client sends `updatedAt` (from local `now()`). Server compares against stored value; on success, server writes its own timestamp. Clock skew between devices can cause unexpected wins — documented, acceptable for v1.

**Idempotency (v1.1 only):** Optional `idempotencyKey` in action args for offline replay; server stores `(userId, key, operationHash)` with TTL.

### Client Migration Notes

| Current | Target (v1) |
|---------|-------------|
| TanStack Start + file routes | Wasp-generated React app + React Router pages |
| `createFileRoute` / `useNavigate` (TanStack) | `useNavigate` / `useLocation` / `useSearch` (React Router) |
| `viewTransition: { types: ["zoom"] }` | React Router `viewTransition: true` + manual `startViewTransition({ types: ['zoom'] })` if needed |
| `fetchNodes` / `send('PATCH')` in `api.ts` | Wasp client ops: `getNodes`, `updateNodes`, etc. |
| Module-scoped bootstrap guards | Per-`userId` bootstrap on auth change |

| Deferred (v1.1) | Target |
|-----------------|--------|
| `queryCollectionOptions` only | + `persistedCollectionOptions` + `BrowserCollectionCoordinator` |
| Direct action calls on mutation | + `startOfflineExecutor` wrapping Wasp action calls |

**Preserve unchanged:**
- `tree-store.ts` (per-node subscriptions)
- `mutations.ts` (collection operations)
- `OutlineEditor` / `OutlineNode` / plugin registry
- `styles.css` view-transition rules

**Sync boundary (Phase 3):**
- `collection.ts` `queryFn` → call `getNodes`, return array
- `onInsert` / `onUpdate` / `onDelete` → call `upsertNodes` / `updateNodes` / `deleteNodes`
- Same `{ refetch: false }` return — keystrokes must not trigger full re-query
- Plugin side-collections: same pattern via plugin actions

### Security & Privacy

| Concern | Mitigation |
|---------|------------|
| **Tenant isolation** | Every query/action filters by `context.user.id`; never trust client-supplied userId |
| **Auth** | Fail closed — Wasp `authRequired: true` on editor pages; operations reject unauthenticated |
| **Password storage** | Wasp-managed hashing (bcrypt/argon2 per Wasp defaults) |
| **Transport** | HTTPS via Railway |
| **Data export** | Founder seed script runs locally; no PII in repo |
| **GDPR / deletion** | Cascade delete user nodes + plugin data on account deletion (US-1) |

### Testing Strategy

| Layer | Tests |
|-------|-------|
| **Unit / type** | `bun run typecheck` (app + Wasp-generated types) |
| **E2e auth** | Login fixture or test bypass; unauthenticated editor redirects to login |
| **E2e editor** | Existing Playwright specs adapted to Wasp dev server port |
| **Migration** | Script test: export fixture D1 JSON → import → row count + sample node text match |
| **View transitions** | Manual QA checklist; optional e2e `document.startViewTransition` spy |
| **Perf** | Benchmark helper: 1000-node seed → measure keystroke commit count (target: ~1 re-render via tree-store) |
| **Offline (v1.1)** | `page.context().setOffline(true)` → edit → reload → online → assert |

---

## 5. Risks & Roadmap

### Phased Rollout (v1)

#### Phase 1 — Wasp scaffold (MVP foundation)
- Wasp TS spec at repo root (same repo); pin `^0.24.x`
- Prisma schema: `User`, `Node` (+ `visibility` default `private`), `TagColor`, `DailyIndexEntry`
- Railway Postgres provisioning
- Email/password auth
- **Exit:** `wasp start` boots; empty user can sign up; health check passes

#### Phase 2 — Wasp queries/actions + auth scoping
- Implement core + plugin queries/actions (semantics ported from `worker/index.ts`, not REST shape)
- LWW in `updateNodes` + server-authoritative `updatedAt`
- Account deletion cascade hook
- **Exit:** Wasp client can CRUD nodes + plugin data with auth; tenant isolation verified

#### Phase 2.5 — E2e auth fixture
- Playwright login flow or test auth bypass
- Adapt `seedOutline` to mock Wasp operations (or seed real test DB)
- **Exit:** Existing e2e specs run authenticated against Wasp dev server

#### Phase 3 — Client port (online)
- React Router migration (2 routes: `/`, `/:nodeId`)
- Sync boundary: collection handlers → Wasp client operations
- Per-user bootstrap guards
- View transitions preserved
- **Exit:** Editor works online; e2e green

#### Phase 4 — Cutover
- D1 export → seed script → founder account
- Pre-cutover backup (D1 JSON export retained)
- Deploy Railway production
- Delete Cloudflare stack (`worker/`, `wrangler.jsonc`, D1 migrations)
- Update README / AGENTS.md
- **Exit:** Founder outline live on Railway; Cloudflare decommissioned

### v1.1 — Offline-first (US-3)

- `persistedCollectionOptions` on all collections
- Offline executor wrapping Wasp action calls + `waitForInit()`
- Multi-tab `BrowserCollectionCoordinator`
- Idempotency table + action arg support
- Offline e2e suite; cold-open KPI ≤ 500 ms cached (network disabled)

### Future (post-v1.1)

| Version | Scope |
|---------|-------|
| **v1.1** | Offline-first (US-3); idempotency for replay |
| **v1.2** | Google OAuth; account settings |
| **v1.3** | Public nodes (`visibility: public` + shareable URL) |
| **v2.0** | Shared subtrees / collaboration (`NodeShare` table); conflict UI (optional) |
| **v2.x** | Real-time push (WebSocket/SSE); extract plugins as Wasp FSMs when stable |

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Wasp FSMs not ready; plugin modularity premature | High | Low | Vertical slices now; npm packaging later |
| React Router view-transition types differ from TanStack | Medium | Medium | Thin wrapper around `document.startViewTransition({ types: ['zoom'] })`; manual QA gate |
| LWW loses edits silently on multi-device | Medium | Medium | Document behavior; server-authoritative timestamps; conflict UI in v2.0 |
| Same-repo Wasp migration conflicts with existing Vite/Start config | Medium | High | Single cutover branch; delete Start config atomically with Wasp add |
| 5,000+ node load-all slow on mobile | Low | Medium | Monitor KPI (desktop broadband); defer lazy-load to v2 |
| Railway single-region latency | Low | Low | Accept for v1; CDN optional later |
| Wasp beta breaking changes | Medium | Medium | Pin Wasp version; follow migration guides |
| E2e auth adds unplanned scope | Medium | Medium | Phase 2.5 with explicit exit criterion |
| Users expect offline at launch | Low | Medium | README honest about online-first v1; US-3 labeled v1.1 |

### Estimated Effort

**4–6 weeks** v1 (Phases 1–4 above, incl. 2.5).

Breakdown (1 engineer):
- Wasp scaffold + repo restructure (~1–2 weeks)
- Queries/actions + LWW (~1 week)
- E2e auth fixture (~3–5 days)
- Client sync boundary + router + view transitions (~1–2 weeks)
- Migration script + cutover (~3–5 days)

**v1.1 offline:** +2 weeks (OPFS, offline executor, idempotency, offline e2e).

---

## Appendix A: Grill Decision Log

Decisions locked during `/grill-with-docs` session (2026-06-25), revised 2026-06-25:

| # | Decision |
|---|----------|
| 1 | Multi-user v1 = private silos; sharing/public later |
| 2 | Wasp queries/actions on server; TanStack DB collections as local optimistic mirror (Option A) |
| 3 | **v1 online-first; offline-first (OPFS + outbox) deferred to v1.1 (US-3)** |
| 4 | Load-all tree (no lazy subtrees v1) |
| 5 | Conflict: last-write-wins via `updatedAt` (silent); server sets timestamp on apply |
| 6 | Auth: email/password only (Wasp defaults) |
| 7 | Data: one-time dev seed script (not user UI) |
| 8 | Delete Cloudflare entirely at cutover |
| 9 | Typed Prisma tables per plugin (not generic KV); FSM-shaped `*.wasp.ts` slices |
| 10 | View transitions: must keep (launch blocker) |
| 11 | Big-bang cutover |
| 12 | Same repo |
| 13 | No custom REST `api()` handlers — Wasp operations are the server contract |

---

## Appendix B: Files Removed at Cutover

- `worker/` (Cloudflare Worker)
- `wrangler.jsonc`
- `migrations/` (D1 SQL — replaced by Prisma migrations)
- TanStack Start-specific: `src/routeTree.gen.ts`, Start vite plugin config
- Cloudflare scripts: `dev:api`, `deploy`, `db:migrate:*`, `build:cf`, `cf:dev`
- `src/data/api.ts` REST fetch calls (replaced by Wasp client operation wrappers)

## Appendix C: Open Questions (post-PRD)

1. **DailyIndexEntry FK:** `onDelete: SetNull` vs `Cascade` when referenced node is deleted.
2. **Railway plan tier:** Postgres sizing for 5k-node payloads on `getNodes` — spike in Phase 1.
3. **Account deletion UX:** hard delete only for v1, or soft delete + retention policy?
4. **Wasp version pin:** target `^0.24.x` TS spec — confirm at Phase 1 kickoff.
