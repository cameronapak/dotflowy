# Lunora replaces custom outline sync

Dotflowy’s hand-rolled per-user DO sync (`/api/sync` + client-planned `{ops}` batches) converges on the same shape Lunora already ships — DO-as-log, poke fan-out, TanStack DB client, watermarked optimistic mutators ([ADR 0008](./0008-sync-via-a-per-user-durable-object.md)). We will **cut over to Lunora** for outline storage/sync so Cam maintains product/UX, not a second sync engine. Until Lunora is ready for production, it remains an opt-in beta beside the classic default. A prior greenfield spike proved ADR 0009’s chain invariant, live multi-tab convergence, watermark hold, shard deny, and hard-reload seed before the production port.

**Decision.** Outline nodes (and, in follow-on slices, kv side-collections) move onto Lunora: `defineTable` + `.shardBy("userId").ownedBy("userId")`, owner shapes, server-authoritative `defineMutator`, and shared pure `plan*` twins on the client through `@lunora/db`. Dotflowy keeps editor, plugins, domain MCP tool names (thin `/mcp` → mutators — [ADR 0026](./0026-agent-native-mcp-server.md) Option A), and existing non-outline HTTP (unfurl, waitlist, admin, Stripe, Better Auth identity) remounted beside Lunora’s Worker compose.

**This supersedes ADR 0008’s deliberate divergence #1** (client-precomputed `{ops}` validated only for shape). Authoritative mutators + shared planners are the trust boundary now; ADR 0009’s P1/P2/P3 become Lunora’s atomic mutator writes + watermark overlay + clientSeq FIFO. Divergence #2 (shape = read-as-permission) stays the future sharing seam.

## Cutover constraints

- **Version floor:** `lunorash@1.0.0-alpha.107`, `@lunora/db@1.0.0-alpha.30`, `@lunora/react@1.0.0-alpha.34`, and coherent companion packages. These contain the Lunora #187 adoption fixes.
- **Flag OFF is cold.** No `LunoraClient`, provider, socket, collection factories, or mutator bindings exist until the synced beta flag is ON. Classic sync remains the production default.
- **No app-owned sync overlay patches.** Do not reintroduce `shapeFirst`, `relayCheckpoints`, `__tanstack_db_direct`, direct optimistic metadata, or the React `jsx-dev-runtime` shim. Lunora owns checkpoint and overlay behavior.
- **Stay on `@lunora/db`.** Dotflowy’s tree-store and structural planners need local collections and indexes; do not rewrite the editor onto raw `useQuery` / `useMutation`.
- **MCP identity:** normal outline tools call the user’s shard as that user. System authority is reserved for wipe, migrate, and admin operations.
- **One system at the end.** Dual-run is a temporary bridge only — not a permanent two-backend mode.
- **No PR to `main` until** the app speaks Lunora for outline sync **and** pre-existing gates are green: `typecheck` / `typecheck:worker` / `typecheck:test` / `lint` / `test` / local Playwright e2e (`test:e2e` with workers=2 clean-signal). Spike-only PRs are not the goal.
- **Data:** one-shot snapshot migrate per-user DO → Lunora shard (export existing outline → `restoreSnapshot`-class import, or Lunora-native seed). Owner `'default'` bridge continuity preserved via `userId` shard key (never email — ADR 0008).
- **Planners stay pure and shared** (`tree.ts` / sibling-chain / `outline-ops` lineage) so MCP, mutators, and any remaining client optimism cannot drift.

## Considered options

| Option                                                                       | Why not                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Keep custom `{ops}` forever; only “look at” Lunora                           | Defeats the maintenance goal; ADR 0008 already named Lunora as convergent. |
| Dual-run in production indefinitely                                          | Two engines, two failure modes; cutover forever deferred.                  |
| Big-bang rewrite in one commit                                               | Editor + e2e + MCP + backups all break together; no incremental proof.     |
| Replace Better Auth / Stripe / unfurl with Lunora primitives in the same cut | Out of scope — remount HTTP; don’t re-litigate identity/billing.           |

## Identity / e2e / kv (locked)

- **Identity:** product Better Auth stays the session authority (MCP OAuth, Stripe, invite/Turnstile). Lunora `resolveIdentity` reads that session — do **not** run a second `@lunora/auth` signup stack in the main app.
- **e2e:** dual-path fixtures — `seedOutline` forces `lunora-sync=off` (classic `/api/sync` mock); `seedOutlineLunora` / `E2E_LUNORA=1` forces ON (`/_lunora/*` mock). **Production defaults OFF** — classic DO is the default for browser and MCP until the user opts in via Settings (`account-prefs` / `lunora-beta`, synced across devices). Local dogfood can force ON with `LUNORA_OUTLINE=1` (Worker MCP) and `?lunora-sync=on` or localStorage (browser).
- **Kill-switch pairing:** the browser reads `isLunoraSyncEnabled()` (`dotflowy:flag:lunora-sync`, mirrored from synced `account-prefs` on load); Worker MCP reads env force first, else the same preference on classic DO (`isLunoraOutlineEnabledForUser`). For local debugging divergence, flip env + client together (`LUNORA_OUTLINE=0` **and** `lunora-sync=off`, or force both ON).
- **KV side-collections:** phase **2b** after nodes sync is on Lunora — do not block the collection swap on tag-colors/daily-index/saved-queries.

## Classic → Lunora migrate completeness (locked)

Daily identity lives in the `daily-index` KV side-collection, not in nodes. A migrate that imports nodes then skips KV (or fails mid-KV) leaves Daily empty forever if the gate is “Lunora already has nodes → skip.” The same trap applies to **nodes**: a mid-import chunk failure can leave some Lunora rows durable while classic still has missing ids — `lunoraNodeCount > 0` must never mean “node migration complete.”

- **Watermarks:** shard table `migrateState` `{ userId, nodesAt, kvAt }` (timestamps; null/absent = incomplete). Split so each half is independently recoverable.
- **`nodesAt` semantics:** stamped only after the classic node snapshot is fully imported. When `nodesAt` is null and classic still has nodes → run node import even if Lunora is nonempty. Default migrate imports **missing classic ids only**. `importNodes` **inserts** new ids and **patches structure only** (`parentId` / `prevSiblingId`) on existing ids — text/task/bookmark fields stay Lunora-local. Never stamp `nodesAt` from `kv-only` / `mark-kv-complete` while classic still has nodes.
- **KV heal:** when `kvAt` is missing → backfill all three classic KV collections (`daily-index`, `tag-colors`, `saved-queries`) via the existing idempotent `importKvRows` path, then set `kvAt`. If classic KV is empty after a **successful** array read and Lunora side-collections already have rows — **or both are empty** (nothing to import) — set `kvAt` without re-import so we don't retry forever. Failed classic GETs **and non-array 200 bodies** must not count as empty. **Never skip solely on `nodes.length > 0`.**
- **Complete watermarks short-circuit:** when both `nodesAt` and `kvAt` are set, migrate returns noop **without** fetching classic DO (avoids spurious `failed` if classic is down).
- **Operator unstick (DevTools):** a false-complete watermark (e.g. `kvAt` stamped after a failed Daily KV pass) needs an explicit clear — `__dotflowyForceLunoraKvHeal()` (`kvAt = null` then re-import KV) or `__dotflowyForceLunoraRemigrate()` (clear both, send **all** classic nodes for structure sync + KV). Plain `__dotflowyMigrateToLunora()` will keep returning `skipped-complete`. These are not wipes; classic stays source for tree links; Lunora field edits are preserved.
- **Orphan Daily days:** if week/scaffold parents are missing while day nodes + `daily-index` mappings survive, the calendar migrator (`planDailyMigration`) treats dangling/`null` parents as in-scope and reattaches under the correct week (and adopts same-label scaffold children when claiming index keys). Force remigrate rewrites Lunora `parentId`s from classic so a repaired classic DO is the structure source of truth.
- **Bootstrap for existing prod shards:** no `migrateState` row + Lunora nodes + no classic nodes + missing `kvAt` uses the KV heal rules above (and may stamp `nodesAt` because classic has nothing left to import).
- **Toggle OFF is one-way:** Settings discloses that turning off returns the last classic snapshot; edits made while upgraded sync is on stay on that backend until turned back on. Reverse Lunora→classic sync is **out of scope** (follow-up ADR later).

## Sequence (implementation order)

1. Spike Phase 0–1 (done): prove mutators/shapes/watermark/bridge/`seedIfEmpty`.
2. ADR (this file) + lift shared planners toward one `src/` core consumed by Worker MCP and Lunora mutators.
3. Integrate Lunora into the main Vite/Worker app on this branch (compose Worker; keep non-outline routes).
4. Swap `nodesCollection` custom sync → `@lunora/db` shape collections; structural path → `bindMutators` (field edits stay direct-style mutators without structural batching).
5. Migrate kv side-collections; remount MCP onto mutators; snapshot-migrate user data; delete `UserOutlineDO` custom changelog sync.
6. Make all pre-existing tests pass; only then open the PR.
