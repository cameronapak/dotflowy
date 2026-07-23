# Lunora replaces custom outline sync

Dotflowy’s hand-rolled per-user DO sync (`/api/sync` + client-planned `{ops}` batches) converges on the same shape Lunora already ships — DO-as-log, poke fan-out, TanStack DB client, watermarked optimistic mutators ([ADR 0008](./0008-sync-via-a-per-user-durable-object.md)). We **cut over to Lunora** for outline storage/sync so Cam maintains product/UX, not a second sync engine. A greenfield spike (`spikes/lunora-outline/`) already proved ADR 0009’s chain invariant, live multi-tab convergence, watermark hold, shard deny, and hard-reload seed.

**Decision.** Outline nodes (and, in follow-on slices, kv side-collections) move onto Lunora: `defineTable` + `.shardBy("userId")`, `defineShape` (`wholeOutline` / later partitions), server-authoritative `defineMutator` with shared pure `plan*` twins on the client (`@lunora/db` + checkpoints). Dotflowy keeps editor, plugins, domain MCP tool names (thin `/mcp` → mutators — [ADR 0026](./0026-agent-native-mcp-server.md) Option A), and existing non-outline HTTP (unfurl, waitlist, admin, Stripe, Better Auth identity) remounted beside Lunora’s Worker compose.

**This supersedes ADR 0008’s deliberate divergence #1** (client-precomputed `{ops}` validated only for shape). Authoritative mutators + shared planners are the trust boundary now; ADR 0009’s P1/P2/P3 become Lunora’s atomic mutator writes + watermark overlay + clientSeq FIFO. Divergence #2 (shape = read-as-permission) stays the future sharing seam.

## Cutover constraints

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

## Sequence (implementation order)

1. Spike Phase 0–1 (done): prove mutators/shapes/watermark/bridge/`seedIfEmpty`.
2. ADR (this file) + lift shared planners toward one `src/` core consumed by Worker MCP and Lunora mutators.
3. Integrate Lunora into the main Vite/Worker app on this branch (compose Worker; keep non-outline routes).
4. Swap `nodesCollection` custom sync → `@lunora/db` shape collections; structural path → `bindMutators` (field edits stay direct-style mutators without structural batching).
5. Migrate kv side-collections; remount MCP onto mutators; snapshot-migrate user data; delete `UserOutlineDO` custom changelog sync.
6. Make all pre-existing tests pass; only then open the PR.
