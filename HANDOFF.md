# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

`phase-2-flag-swap` — outline sync can ride Lunora shapes/mutators behind a **default-OFF** flag. Custom `/api/sync` + `nodesCollection` + `runStructural` remain the default path (Playwright classic suite + normal `bun run dev`). **No PR until remaining gaps close + e2e green on Lunora (or still on old wire by design).**

## Flag — Lunora outline sync

|             |                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**    | `dotflowy:flag:lunora-sync`                                                                                                             |
| **Getter**  | `isLunoraSyncEnabled()` in `src/data/flags.ts`                                                                                          |
| **Default** | **OFF**                                                                                                                                 |
| **Enable**  | `localStorage.setItem("dotflowy:flag:lunora-sync", "on")` then reload, **or** `?lunora-sync=on` (URL wins for that load; not persisted) |
| **Disable** | `"off"` in localStorage, or `?lunora-sync=off`                                                                                          |

### Smoke (flag ON)

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

### dailyIndex on Lunora (KV 2b finish)

| Mutator              | Notes                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| `claimDailyMapping`  | Atomic get-or-create; bumps `touchedAt` so watermark poke always fires |
| `upsertDailyMapping` | `setMapping` / migrate heal                                            |
| `deleteDailyMapping` | delete                                                                 |

- Table `dailyIndex` `.shardBy("userId")`, shape `userDailyIndex`, pure `resolveDailyClaim` unit-tested.
- Flag ON: `claimMapping` / daily index feed use Lunora; flag OFF unchanged `/api/kv`.
- `materializeDailyNodes` still the node half after claims (ADR 0041 seedEntryLine unchanged).

### DO → Lunora migrate

- `src/data/lunora-migrate.ts` — auto on flag-ON empty shard; More menu + `__dotflowyMigrateToLunora`.
- Imports nodes via `importNodes` chunks (~500) + tag/saved/daily kv upserts.

### e2e foundation

- `seedOutlineLunora` in `e2e/fixtures.ts` — mocks `/_lunora/ws` + `/_lunora/rpc`, enables flag via init script.
- `e2e/lunora-sync-smoke.spec.ts` — load + edit + reload smoke.
- Classic `seedOutline` untouched (flag OFF suite).

### Prior slices (still true)

appendChild / importNodes / tagColors / savedQueries / multi-select / materializeDailyNodes / restoreNodes / mirrorNode / field+structural mutators / flag-swap architecture — see git log.

## Known gaps (toward flag-default-ON)

- Full Playwright suite still on classic wire; only one Lunora smoke (expand fixture coverage).
- Daily flat→nested migration under Lunora dogfood; MCP remount onto mutators.
- Snapshot/R2 restore path still classic DO; delete `UserOutlineDO` custom sync **out of scope** until gates green.
- OPML mid-chunk failure can leave earlier chunks; tree-store Lunora feed is full rebuild per change.
- Flag must stay **default OFF** until migrate+e2e are dogfood-solid.

## Gates (flag OFF)

```sh
bun run lunora:codegen   # after lunora/ edits
bun run typecheck && bun run typecheck:worker && bun run typecheck:test
bun run lint && bun run test
# optional: bun run test:e2e e2e/lunora-sync-smoke.spec.ts
```

## Next

1. Harden `seedOutlineLunora` (more mutators, daily claim) + expand smoke / port a few critical specs.
2. Dogfood migrate on a real account; MCP remount; then consider flag default ON.
3. Green gates → PR; **delete this `HANDOFF.md` in the shipping PR.**

## Note

Root Dotflowy = bun. Spike = pnpm only inside `spikes/lunora-outline`.
