# PRD: Dotflowy Platform Migration (Cloudflare → Wasp + Railway)

**Status:** Draft (grill-complete)  
**Author:** Cameron Pak + agent session  
**Last updated:** 2026-06-25  
**Repo:** Same repo (`dotflowy`) — in-place restructure  

---

## 1. Executive Summary

### Problem Statement

Dotflowy is a local-first outline editor currently deployed as a single-user Cloudflare Worker + D1 stack with HTTP Basic Auth / Cloudflare Access. The product roadmap requires **multi-user accounts**, **true offline-first sync**, and a maintainable full-stack foundation — without sacrificing the editor's sub-frame typing performance or zoom view transitions. The Cloudflare stack was the right v1 deployment target; it is not the right long-term platform for auth, Postgres, or modular plugin growth.

### Proposed Solution

Migrate Dotflowy to **Wasp** (TS spec + React + Node/Express + Prisma) deployed on **Railway** with **PostgreSQL**. Keep **TanStack DB** on the client as the optimistic collection layer; add **OPFS SQLite persistence** and an **offline transaction outbox** for full offline-first behavior. Replace the generic `/api/kv` store with **typed Prisma models per plugin**, structured as vertical slices (`*.wasp.ts` per plugin) to align with future Wasp Full-Stack Modules (FSMs). Launch with **private per-user silos**; schema reserves hooks for sharing/public nodes in a later release.

### Success Criteria

| KPI | Target | Measurement |
|-----|--------|-------------|
| **Keystroke-to-paint latency** | ≤ 16 ms (one frame at 60 Hz) for text edits on a 1,000-node outline | Playwright + `performance.now()` instrumentation on `nodesCollection.update` → DOM commit |
| **Cold open (cached)** | App interactive within 500 ms on repeat visit (network offline) | Lighthouse / manual: OPFS hydrate → first editable bullet focused |
| **Full sync load** | Initial GET + tree build ≤ 2 s for 5,000 nodes on broadband | Server timing + client `fetchNodes` → `toArrayWhenReady` |
| **Offline write durability** | 100% of edits made offline persist across tab close + replay on reconnect | e2e: airplane mode → edit → kill tab → online → verify server state |
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

### User Stories

#### US-1: Account creation and sign-in

**As a** new user, **I want to** create an account with email and password **so that** my outline is private and synced to my identity.

**Acceptance criteria:**
- Wasp username/password auth enabled; no OAuth in v1.
- Every API request scoped to authenticated `userId`; unauthenticated requests receive 401.
- User A cannot read, write, or delete User B's nodes or plugin data.
- Session persists across browser restarts (Wasp default JWT/session behavior).

#### US-2: Edit outline with existing editor UX

**As a** signed-in user, **I want to** use the full Dotflowy editor (bullets, zoom, tasks, tags, links, daily notes, plugins) **so that** the migration changes nothing about how I work.

**Acceptance criteria:**
- All features listed in README "What works" remain functional post-migration.
- Keystroke latency meets KPI (≤ 16 ms local paint).
- Zoom view transitions (dot-click morph) preserved; `prefers-reduced-motion` respected.
- Undo/redo, drag-reorder, Cmd+K switcher, bookmarks, tag filter (`?q=`), and plugin seams unchanged in behavior.

#### US-3: Work offline

**As a** user, **I want to** read and edit my outline without network **so that** I can work on planes, in tunnels, or during outages.

**Acceptance criteria:**
- After at least one successful sync, app opens and is editable with network disabled (OPFS cache).
- Edits queue in offline outbox (`@tanstack/offline-transactions`); UI updates optimistically immediately.
- On reconnect, outbox replays automatically with exponential backoff.
- Pending mutations survive tab close and browser restart (IndexedDB outbox + OPFS cache).
- Multi-tab: `BrowserCollectionCoordinator` prevents SQLite corruption; one leader processes outbox.

#### US-4: Sync across devices

**As a** user signed in on two devices, **I want to** see edits from the other device **so that** my outline stays consistent.

**Acceptance criteria:**
- Tab focus triggers full-node-set refetch (existing `refetchOnWindowFocus` behavior preserved).
- Conflict resolution: **last-write-wins** — server PATCH applies only when `changes.updatedAt >= row.updatedAt`; stale writes dropped silently.
- Idempotency keys on write APIs prevent duplicate rows on offline replay retry.

#### US-5: Founder data migration

**As the** founder, **I want to** one-time import my existing D1 outline **so that** I don't lose my data at cutover.

**Acceptance criteria:**
- Dev-only script: export D1 → JSON file → import into specified Wasp `User.id`.
- Not exposed as in-app "import backup" UI in v1.
- Import is idempotent or guarded (re-run does not duplicate nodes).

#### US-6: Plugin data syncs per-plugin

**As a** user, **I want to** tag colors and daily-note identity to follow me across devices **so that** plugin features feel as reliable as the core outline.

**Acceptance criteria:**
- `TagColor` and `DailyIndexEntry` stored in typed Prisma tables (not generic KV).
- Each plugin owns its API route(s) and `*.wasp.ts` spec slice.
- TanStack DB side-collections on client point at plugin-specific endpoints.

### Non-Goals (v1)

- **Sharing / collaboration** — no invites, no shared subtrees, no public URLs (schema may stub `visibility` or `NodeShare`; no UI).
- **Real-time push / WebSockets** — sync remains reconcile-on-focus + offline outbox replay.
- **OAuth providers** (Google, GitHub) — email/password only at launch.
- **Wasp Full-Stack Modules (npm packages)** — structure like FSMs; do not block on experimental FSM packaging.
- **Lazy subtree loading / pagination** — load-all tree model retained.
- **Conflict UI** — silent LWW; no merge dialog or 409 surfacing to user in v1.
- **Parallel Cloudflare run** — big-bang cutover; Worker/D1/wrangler deleted after launch.
- **In-app legacy import UI** — D1 → seed script only.
- **Client rewrite to Wasp operations** — TanStack DB collections remain the client sync layer.

---

## 3. AI System Requirements

**Not applicable.** This migration has no LLM, agent, or AI-inference components.

---

## 4. Technical Specifications

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (SPA)                                                  │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │ React Editor │→ │ TanStack DB     │→ │ OPFS SQLite cache  │  │
│  │ + plugins    │  │ collections     │  │ (persistedCollection│ │
│  │              │  │ (optimistic)    │  │  Options)          │  │
│  └──────────────┘  └────────┬────────┘  └────────────────────┘  │
│                             │                                   │
│                    ┌────────▼────────┐                          │
│                    │ Offline executor │ (outbox → IndexedDB)    │
│                    └────────┬────────┘                          │
└─────────────────────────────┼───────────────────────────────────┘
                              │ REST (same-origin)
                              │ GET/POST/PATCH/DELETE
┌─────────────────────────────▼───────────────────────────────────┐
│  Wasp Server (Node/Express on Railway)                          │
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │ Wasp auth    │  │ Custom APIs     │  │ Plugin APIs        │  │
│  │ (email/pass) │  │ /api/nodes      │  │ /api/tag-colors    │  │
│  └──────────────┘  └────────┬────────┘  │ /api/daily-index   │  │
│                             │           └─────────┬──────────┘  │
│                    ┌────────▼─────────────────────▼──────────┐  │
│                    │ Prisma → PostgreSQL (Railway)           │  │
│                    │ User, Node, TagColor, DailyIndexEntry   │  │
│                    └─────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Data flow (happy path):**
1. Login → Wasp session JWT.
2. `fetchNodes` GET all rows for `userId` → hydrate TanStack DB collection + OPFS.
3. Keystroke → `nodesCollection.update` (sync, local) → tree-store re-renders one bullet.
4. Background → batched PATCH to `/api/nodes` with `{ refetch: false }`.
5. Tab focus → full GET reconciles with server.
6. Offline → outbox queues writes; replay on `online` event with idempotency keys.

### Integration Points

| Integration | Detail |
|-------------|--------|
| **Wasp TS spec** | `main.wasp.ts` + per-plugin `*.wasp.ts` slices (routes, auth, entities, APIs) |
| **Database** | PostgreSQL on Railway; Prisma migrations replace D1 SQL migrations |
| **Auth** | Wasp username/password; `context.user.id` scopes all queries |
| **Client routing** | TanStack Router → React Router 7; preserve `location.state.pivotId` + `viewTransition` |
| **Node API** | Custom Wasp `api()` handlers (port of `worker/index.ts` semantics) |
| **TanStack DB** | `@tanstack/react-db`, `@tanstack/query-db-collection`, `@tanstack/browser-db-sqlite-persistence`, `@tanstack/offline-transactions` |
| **Deploy** | Railway (app + Postgres); remove `wrangler`, `worker/`, Cloudflare bindings |
| **E2e** | Playwright against Wasp dev server; mock or hit real API per existing fixture patterns |

### Data Model (Prisma)

**Core — `Node`** (mirrors existing `src/data/schema.ts`; `owner` → `userId`):

```
Node {
  id, userId, parentId, prevSiblingId,
  text, isTask, completed, collapsed,
  bookmarkedAt, createdAt, updatedAt
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
```

**Future sharing (stub only, v1 unused):**
- Option A: `Node.visibility: 'private' | 'public'` (nullable, default private).
- Option B: `NodeShare { nodeId, sharedWithUserId, role }` join table.
- Decision deferred to pre-sharing PRD; migration must not paint into a corner.

### API Contract

#### `/api/nodes` (authenticated)

| Method | Body | Behavior |
|--------|------|----------|
| GET | — | Return all nodes for `context.user.id` |
| POST | `{ nodes: Node[] }` | Upsert batch; idempotent with idempotency key header |
| PATCH | `{ updates: { id, changes }[] }` | Apply only if `changes.updatedAt >= row.updatedAt` (LWW) |
| DELETE | `{ ids: string[] }` | Delete where `id` AND `userId` match |

#### Plugin routes

Replace `/api/kv?collection=` with dedicated routes matching existing client fetch shapes (or thin adapter in `kv-api.ts` during transition).

### Client Migration Notes

| Current | Target |
|---------|--------|
| TanStack Start + file routes | Wasp-generated React app + React Router |
| `createFileRoute` / `useNavigate` (TanStack) | `useNavigate` / `useLocation` / `useSearch` (React Router) |
| `viewTransition: { types: ["zoom"] }` | React Router `viewTransition: true` + manual `startViewTransition({ types: ['zoom'] })` if needed for typed CSS |
| `queryCollectionOptions` only | Wrap with `persistedCollectionOptions` + `BrowserCollectionCoordinator` |
| No offline outbox | `startOfflineExecutor` + idempotent mutation fns |

**Preserve unchanged:**
- `tree-store.ts` (per-node subscriptions)
- `mutations.ts` (collection operations)
- `OutlineEditor` / `OutlineNode` / plugin registry
- `styles.css` view-transition rules

### Security & Privacy

| Concern | Mitigation |
|---------|------------|
| **Tenant isolation** | Every query filters by `userId` from Wasp auth context; never trust client-supplied owner |
| **Auth** | Fail closed — no anonymous access to `/api/*` |
| **Password storage** | Wasp-managed hashing (bcrypt/argon2 per Wasp defaults) |
| **Transport** | HTTPS via Railway |
| **Idempotency** | `Idempotency-Key` header on writes; server dedupes replayed offline transactions |
| **Data export** | Founder seed script runs locally; no PII in repo |
| **GDPR / deletion** | v1: cascade delete user nodes on account deletion (Wasp hook + Prisma `onDelete`) — implement in Phase 2 |

### Testing Strategy

| Layer | Tests |
|-------|-------|
| **Unit / type** | `bun run typecheck` (app + Wasp-generated types) |
| **E2e** | Existing Playwright specs adapted to Wasp dev server port |
| **Offline** | New e2e: `page.context().setOffline(true)` → edit → reload → online → assert |
| **Migration** | Script test: export fixture D1 JSON → import → row count + sample node text match |
| **View transitions** | Manual QA checklist; optional e2e `document.startViewTransition` spy |
| **Perf** | Benchmark helper: 1000-node seed → measure keystroke commit count (target: ~1 re-render via tree-store) |

---

## 5. Risks & Roadmap

### Phased Rollout

#### Phase 1 — Wasp scaffold (MVP foundation)
- Wasp TS spec at repo root (same repo)
- Prisma schema: `User`, `Node`, `TagColor`, `DailyIndexEntry` + sharing stub
- Railway Postgres provisioning
- Email/password auth
- **Exit:** `wasp start` boots; empty user can sign up; health check passes

#### Phase 2 — Server APIs + auth scoping
- Port `worker/index.ts` → Wasp custom APIs
- LWW PATCH handler + idempotency keys
- Plugin-specific routes; delete generic KV
- **Exit:** Postman/curl CRUD against `/api/nodes` with auth; tenant isolation verified

#### Phase 3 — Client port
- React Router migration (2 routes: `/`, `/:nodeId`)
- TanStack DB collections → Wasp API endpoints
- View transitions preserved
- **Exit:** Editor works online; e2e green (minus offline specs)

#### Phase 4 — Offline-first
- `persistedCollectionOptions` on all collections
- Offline executor + `waitForInit()`
- Multi-tab coordinator
- **Exit:** Offline e2e green; KPI cold-open ≤ 500 ms cached

#### Phase 5 — Cutover
- D1 export → seed script → founder account
- Deploy Railway production
- Delete Cloudflare stack (`worker/`, `wrangler.jsonc`, D1 migrations)
- Update README / AGENTS.md
- **Exit:** Founder outline live on Railway; Cloudflare decommissioned

### Future (post-v1)

| Version | Scope |
|---------|-------|
| **v1.1** | Google OAuth; account settings |
| **v1.2** | Public nodes (`visibility: public` + shareable URL) |
| **v2.0** | Shared subtrees / collaboration; conflict UI (optional) |
| **v2.x** | Real-time push (WebSocket/SSE); extract plugins as Wasp FSMs when stable |

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Wasp FSMs not ready; plugin modularity premature | High | Low | Vertical slices now; npm packaging later |
| React Router view-transition types differ from TanStack | Medium | Medium | Thin wrapper around `document.startViewTransition({ types: ['zoom'] })`; manual QA gate |
| Offline outbox + LWW loses edits silently on multi-device | Medium | Medium | Document behavior; v1.2 conflict UI; founder mostly single-device |
| OPFS unavailable (Safari private mode) | Low | Medium | Graceful degrade to online-only (`onStorageFailure`); toast warning |
| Same-repo Wasp migration conflicts with existing Vite/Start config | Medium | High | Single cutover branch; delete Start config atomically with Wasp add |
| 5,000+ node load-all slow on mobile | Low | Medium | Monitor KPI; defer lazy-load to v2 |
| Railway single-region latency | Low | Low | Accept for v1; CDN optional later |
| Wasp beta breaking changes | Medium | Medium | Pin Wasp version; follow migration guides |

### Estimated Effort

**4–6 weeks** focused development (1 engineer), assuming:
- Offline executor + persistence are net-new (~1–2 weeks)
- Router port + view transitions (~3–5 days)
- Plugin server slices (~3–5 days)
- E2e adaptation + migration script (~3–5 days)

---

## Appendix A: Grill Decision Log

Decisions locked during `/grill-with-docs` session (2026-06-25):

| # | Decision |
|---|----------|
| 1 | Multi-user v1 = private silos; sharing/public later |
| 2 | Keep TanStack DB on client (not Wasp operations) |
| 3 | Full offline-first: OPFS persistence + offline outbox |
| 4 | Load-all tree (no lazy subtrees v1) |
| 5 | Conflict: last-write-wins via `updatedAt` (silent) |
| 6 | Auth: email/password only |
| 7 | Data: one-time dev seed script (not user UI) |
| 8 | Delete Cloudflare entirely at cutover |
| 9 | Typed Prisma tables per plugin (not generic KV); FSM-shaped slices |
| 10 | View transitions: must keep (launch blocker) |
| 11 | Big-bang cutover |
| 12 | Same repo |

---

## Appendix B: Files Removed at Cutover

- `worker/` (Cloudflare Worker)
- `wrangler.jsonc`
- `migrations/` (D1 SQL — replaced by Prisma migrations)
- TanStack Start-specific: `src/routeTree.gen.ts`, Start vite plugin config
- Cloudflare scripts: `dev:api`, `deploy`, `db:migrate:*`, `build:cf`, `cf:dev`

## Appendix C: Open Questions (post-PRD)

1. **Sharing schema:** `Node.visibility` enum vs `NodeShare` table — decide before v1.2, stub in Phase 1.
2. **Railway plan tier:** Postgres sizing for 5k-node JSON payloads on GET.
3. **Account deletion UX:** hard delete vs soft delete — required for multi-user GDPR hygiene.
4. **Wasp version pin:** target `^0.24.x` TS spec; confirm at Phase 1 kickoff.
