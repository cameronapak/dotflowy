# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

`phase-2-flag-swap` — outline sync can ride Lunora shapes/mutators behind a **default-OFF** flag. Custom `/api/sync` + `nodesCollection` + `runStructural` remain the default path (Playwright classic suite + normal `bun run dev`). **No PR until remaining gaps close + e2e green on Lunora (or still on old wire by design).**

## Flag — Lunora outline sync (client)

|             |                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**    | `dotflowy:flag:lunora-sync`                                                                                                             |
| **Getter**  | `isLunoraSyncEnabled()` in `src/data/flags.ts`                                                                                          |
| **Default** | **OFF**                                                                                                                                 |
| **Enable**  | `localStorage.setItem("dotflowy:flag:lunora-sync", "on")` then reload, **or** `?lunora-sync=on` (URL wins for that load; not persisted) |
| **Disable** | `"off"` in localStorage, or `?lunora-sync=off`                                                                                          |

## Flag — Lunora MCP store (Worker)

|              |                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**     | `LUNORA_OUTLINE` (env / `.dev.vars`)                                                                                                                                            |
| **Getter**   | `isLunoraOutlineEnabled(env)` in `worker/lunora-mcp-store.ts`                                                                                                                   |
| **Default**  | **OFF** (unset)                                                                                                                                                                 |
| **Enable**   | `LUNORA_OUTLINE=1` (or `true`) in `.dev.vars` / wrangler secrets — see `.dev.vars.example`                                                                                      |
| **Behavior** | When ON: `/mcp` tools plan via `outline-ops` then commit through Lunora `mcp:applyChangeOps` + `mcp:listNodes` on the user shard. When OFF: classic `UserOutlineDO.applyBatch`. |

Pair with the client flag for dogfood (same shard key = Better Auth `user.id`).

### Smoke (client flag ON)

```sh
bun run lunora:codegen          # after lunora/ edits
bun run dev                     # vite :3000 + wrangler :8787
# sign in (seed:user if needed)
# DevTools:
localStorage.setItem("dotflowy:flag:lunora-sync", "on")
location.reload()
# Or open http://localhost:3000/?lunora-sync=on
```

Expect: if classic DO has data and Lunora shard is empty → **auto-migrate** once (nodes + tag-colors + saved-queries + daily-index). Else empty Lunora seeds demo bullets via `seedIfEmpty`. Editor mutators + kv (incl. **dailyIndex / claimDailyMapping**) ride `/_lunora/*`. Second tab same user → live converge.

## Migrate runbook (classic DO → Lunora)

**Safe default: skip if Lunora already has any nodes** (no replace). Classic `UserOutlineDO` data is never deleted.

### Automatic (preferred)

1. Enable `dotflowy:flag:lunora-sync` and reload while signed in.
2. On first ready load: if Lunora `wholeOutline` is empty **and** `GET /api/nodes` returns rows → chunked `importNodes` + kv upserts.
3. Console: `[lunora-migrate] imported N nodes + K kv rows from classic DO`.

### Manual retry

- **More menu** (flag ON only): "Migrate to Lunora" — same skip-if-nonempty semantics; toasts the outcome.
- **DevTools:** `await window.__dotflowyMigrateToLunora()` → `{ status, nodes?, kv?, error? }`.

Statuses: `migrated` | `skipped-nonempty` | `skipped-empty-source` | `failed`.

## What landed (this slice)

### e2e Lunora subset (fixture expanded)

- `seedOutlineLunora` — planner-backed `/_lunora/rpc` mock (split/indent/outdent/remove/restore/field patches + daily claim).
- Specs (flag ON via fixture; classic suite untouched):
  - `e2e/lunora-sync-smoke.spec.ts` — load + edit + hard reload
  - `e2e/lunora-structural.spec.ts` — Enter split, Tab indent, `/delete` + reload
  - `e2e/lunora-undo.spec.ts` — Cmd+Z / Cmd+Shift+Z via `restoreNodes`

```sh
bunx playwright test e2e/lunora-*.spec.ts
```

**Last run (this slice):** 5 passed (chromium).

### MCP remount (Worker flag)

- `lunora/mcp.ts` — internal `listNodes` / `listDailyIndex` / `applyChangeOps` (system RPC only).
- `worker/lunora-mcp-store.ts` — `OutlineStore` → shard via `resolveShard` + `x-lunora-system`.
- `planFromChangeOps` (`src/data/outline-plans/change-ops.ts`) — pure ChangeOp → OutlinePlan.
- Spoiler redaction + daily `claimDailyMapping` unchanged on the tool path.
- Default OFF; set `LUNORA_OUTLINE=1` for local MCP↔Lunora.

### Prior slices (still true)

dailyIndex / claimDailyMapping / DO→Lunora migrate / field+structural mutators / flag-swap architecture — see git log.

## Known gaps → flag-default-ON checklist

Keep **client flag default OFF** until all of these are solid:

1. **Dogfood migrate** on a real account (auto + More menu); confirm daily flat→nested migration under Lunora.
2. **MCP dogfood** with `LUNORA_OUTLINE=1` against a live Worker (not only unit wiring).
3. **Expand Lunora e2e** as needed (daily claim, multi-select, markdown paste) — not the whole classic suite.
4. **Snapshot/R2/PITR** still classic DO — out of scope until gates green; delete `UserOutlineDO` only after.
5. OPML mid-chunk failure can leave earlier chunks; tree-store Lunora feed is full rebuild per change.
6. Gates green with flag OFF (always) + Lunora subset green; then consider flipping client default ON (and Worker env for prod MCP).

## Gates (flag OFF)

```sh
bun run lunora:codegen   # after lunora/ edits
bun run typecheck && bun run typecheck:worker && bun run typecheck:test
bun run lint && bun run test
bunx playwright test e2e/lunora-*.spec.ts
```

## Next

1. Dogfood migrate + `LUNORA_OUTLINE=1` MCP against `bun run dev`.
2. Close checklist above → consider flag default ON.
3. Green gates → PR; **delete this `HANDOFF.md` in the shipping PR.**

## Note

Root Dotflowy = bun. Spike = pnpm only inside `spikes/lunora-outline`.
