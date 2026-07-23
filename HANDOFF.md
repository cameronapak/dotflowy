# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

`phase-2-flag-swap` — outline sync can ride Lunora shapes/mutators behind a **default-OFF** flag. Custom `/api/sync` + `nodesCollection` + `runStructural` remain the default path (Playwright + normal `bun run dev`). **No PR until remaining gaps close + e2e green on Lunora (or still on old wire by design).**

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

Expect: empty Lunora shard seeds demo bullets via `seedIfEmpty`; Enter / Tab / Shift+Tab / Backspace / typing / Cmd+Z / `/mirror` / multi-select Tab·Shift+Tab·Delete / Today get-or-create / quick-add born / OPML import / tag color + saved filter writes use Lunora mutators + watermark checkpoints; Network shows `/_lunora/*` (not `/api/sync` for outline, not `/api/kv` for tag-colors/saved-queries). Second tab same user → live converge. **dailyIndex still hits `/api/kv`.**

## What landed (this slice)

### Quick-add append + OPML import + drag check + KV 2b start

| Mutator            | Planner           | Notes                                                                                          |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------- |
| `appendChild`      | `planAppendChild` | Quick-add born — server resolves last sibling; **one watermark** per capture                   |
| `importNodes`      | `planImportNodes` | OPML dialog; insert-only chunks of ~500; **clientSeq FIFO**; mid-fail can leave earlier chunks |
| `upsertTagColor`   | (inline)          | Phase 2b — tag color put                                                                       |
| `deleteTagColor`   | (inline)          | Phase 2b — tag color clear                                                                     |
| `upsertSavedQuery` | (inline)          | Phase 2b — pin save                                                                            |
| `patchSavedQuery`  | (inline)          | Phase 2b — rename                                                                              |
| `deleteSavedQuery` | (inline)          | Phase 2b — unsave / row delete (client bind name `deleteSavedQueryRow`)                        |

- **Drag-reorder:** already hits `moveNode` via `OutlineEditor` → `runStructural` → Lunora-wired `mutations.moveNode`. No change needed.
- **KV tables:** `tagColors` + `savedQueries` in `lunora/schema.ts`, shapes `userTagColors` / `userSavedQueries`. Same `isLunoraSyncEnabled()` flag (no sub-flag). Bound into the outline store's **one** `bindMutators` (shared clientSeq FIFO with node writes).
- **dailyIndex:** still `/api/kv` + `claimMapping` — deferred until atomic get-or-create ports (not in this slice).
- Worker `KV_COLLECTIONS` path unchanged for flag OFF.

### Multi-select batches + resolveMirror + daily (still true)

| Mutator                 | Planner                        | Notes                                                                                       |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `removeMany`            | `planRemoveMany`               | Selection delete — ONE watermark; rebuilds between sibling deletes                          |
| `moveMany`              | `planMoveMany`                 | Selection move / Send-to-Today later — ONE watermark                                        |
| `indentMany`            | `planIndentMany`               | Selection Tab; `resolveMirror` → SOURCE                                                     |
| `outdentMany`           | `planOutdentMany`              | Selection Shift+Tab                                                                         |
| `materializeDailyNodes` | `planMaterializeDailyNodes`    | Daily scaffold+day(+seed) after kv `claimMapping`; ADR 0041 `seedEntryLine` in same mutator |
| `indent` (updated)      | `planIndent` + `resolveMirror` | Mirror prev-sibling parents into SOURCE (was skipped when mirrors ON)                       |

- Multi planners rebuild a working copy between sibling ops, then `planRestoreNodes`-diff to one plan.
- `mutations.ts` branches when `isLunoraSyncEnabled()`; selection-mode keeps calling `*ManyNodes` (no UI change).
- Daily: kv claims stay on `/api/kv`; node half is Lunora-only. `hasNode` / seed checks read Lunora collection when flag ON.

### History restore + mirrors (still true)

| Mutator        | Planner            | Notes                                                                 |
| -------------- | ------------------ | --------------------------------------------------------------------- |
| `restoreNodes` | `planRestoreNodes` | Full target snapshot → one watermark; `runHistoryRestore` routes here |
| `mirrorNode`   | `planMirrorNode`   | `/mirror` + `mutations.mirrorNode`; flatten + cycle + trueSource dest |

### Prior mutator/planner parity (still true)

| Mutator                   | Planner                  | Notes                                                   |
| ------------------------- | ------------------------ | ------------------------------------------------------- |
| `insertSibling`           | `planInsertSibling`      | prior                                                   |
| `insertChildAtStart`      | `planInsertChildAtStart` | Enter into expanded parent                              |
| `splitNode`               | `planSplitNode`          | Enter mid-split — ONE watermark (setText+insertSibling) |
| `outdent` / `removeNode`  | prior                    | prior                                                   |
| `moveNode`                | `planMoveNode`           | Cmd+Shift+↑/↓ + **drag-reorder**; edge reparent OK      |
| `setText` / field toggles | matching `planSet*`      | completed/collapsed/isTask/kind/bookmarkedAt            |
| `seedIfEmpty` / `hello`   | prior                    | prior                                                   |

### Flag-swap architecture

```
Flag OFF (default):
  OutlineEditor → mutations/runStructural → nodesCollection → /api/sync + UserOutlineDO
  tag-colors / saved-queries / daily-index → /api/kv

Flag ON:
  LunoraSyncHost → createOutlineStore(wholeOutline + userTagColors + userSavedQueries + bindMutators)
       ↓ subscribeChanges
  tree-store.resetTreeFromNodes (ADR 0004 feed)
  tag-colors / saved-queries bindLunora* feeds
       ↑
  mutations (+ mirror / multi / daily / appendChild) / OPML importNodes / runHistoryRestore
  runStructural → body only (watermark hold is checkpoints, not waitForSeq)
  dailyIndex → still /api/kv
```

| File                                    | Role                                                    |
| --------------------------------------- | ------------------------------------------------------- |
| `src/data/flags.ts`                     | `isLunoraSyncEnabled()`                                 |
| `src/data/lunora-client.ts`             | singleton `LunoraClient` → same-origin `/_lunora`       |
| `src/data/lunora-outline-store.ts`      | nodes + tagColors + savedQueries + `bindMutators`       |
| `src/data/lunora-kv-store.ts`           | KV row types (phase 2b)                                 |
| `src/data/lunora-bridge.ts`             | rows → TreeIndex / Node                                 |
| `src/data/lunora-sync.ts`               | start/stop, feed tree-store + kv binds, seedIfEmpty     |
| `src/components/lunora-sync-host.tsx`   | AuthGate child; LunoraProvider when flag ON             |
| `src/components/history-restore.tsx`    | flag ON → `restoreNodes` mutator                        |
| `src/components/opml-import-dialog.tsx` | flag ON → chunked `importNodes`                         |
| `src/plugins/daily/get-or-create.ts`    | flag ON → `materializeDailyNodes` (kv claims unchanged) |
| `src/data/tag-colors.ts`                | flag ON → Lunora mutators + shape feed                  |
| `src/data/saved-queries.ts`             | flag ON → Lunora mutators + shape feed                  |
| `src/data/collection.ts`                | flag ON → skip `/api/sync` socket                       |
| `src/data/structural.ts`                | flag ON → no `{ops}` / waitForSeq                       |
| `src/data/mutations.ts`                 | Lunora mutator surface (+ appendChild)                  |
| `src/data/outline-plans/`               | shared pure planners + unit tests                       |
| `lunora/mutators.ts`                    | server `defineMutator` twin                             |
| `lunora/schema.ts` / `shapes.ts`        | nodes + tagColors + savedQueries                        |

### Deps (root, bun)

- `@lunora/db@1.0.0-alpha.27`, `@lunora/react@1.0.0-alpha.31`
- `@tanstack/db@^0.6.16`, `@tanstack/offline-transactions@^1.0.41`
- Existing: `lunorash@1.0.0-alpha.98`

## Known gaps (flag ON)

- **Not ported:** dailyIndex / `claimMapping` atomic get-or-create, daily flat→nested migration under Lunora, full plugin structural paths beyond what's wired, `resyncNodes` no-op when flag ON
- **OPML large import:** chunked `importNodes` — a mid-import failure can leave earlier chunks durable (documented in dialog copy); flag-OFF path stays all-or-nothing
- **Quick-add pre-born intents** (`/todo` before first keystroke): still separate field mutators after `appendChild` (rare); born insert itself is one watermark
- **e2e** still on old wire (`seedOutline`); flag must stay OFF for Playwright
- **No data migrate** from UserOutlineDO → Lunora shard yet (flag ON = empty/new Lunora outline; kv rows similarly empty until rewritten)
- Tree-store Lunora feed is **full rebuild** per change (fine for dogfood; not the incremental hot path)

## Gates (flag OFF)

```sh
bun run typecheck
bun run typecheck:worker
bun run test                    # includes flags + lunora-bridge + outline-plans
```

## Next

1. Lunora-aware e2e fixture (mock `/_lunora` or Miniflare) — keep `seedOutline` until then.
2. dailyIndex + `claimMapping` on Lunora; MCP remount; snapshot migrate; delete `UserOutlineDO` custom sync.
3. Optional: fold quick-add intents into `appendChild` args; OPML single-watermark for small imports.
4. Green gates → PR; **delete this `HANDOFF.md` in the shipping PR.**

## Note

Root Dotflowy = bun. Spike = pnpm only inside `spikes/lunora-outline`.
