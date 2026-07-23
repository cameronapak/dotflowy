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

Expect: empty Lunora shard seeds demo bullets via `seedIfEmpty`; Enter / Tab / Shift+Tab / Backspace / typing use Lunora mutators + watermark checkpoints; Network shows `/_lunora/*` (not `/api/sync` for outline). Second tab same user → live converge.

## What landed (this slice)

### Mutator/planner parity widen (flag ON)

Dogfood surface expanded beyond the original 5 ops. Shared pure planners in
`src/data/outline-plans/`; server `defineMutator` in `lunora/mutators.ts`;
client `@lunora/db/mutators` in `src/data/lunora-outline-store.ts`;
`mutations.ts` branches when `isLunoraSyncEnabled()`.

| Mutator                             | Planner                  | Notes                                                   |
| ----------------------------------- | ------------------------ | ------------------------------------------------------- |
| `insertSibling`                     | `planInsertSibling`      | prior                                                   |
| `insertChildAtStart`                | `planInsertChildAtStart` | Enter into expanded parent                              |
| `splitNode`                         | `planSplitNode`          | Enter mid-split — ONE watermark (setText+insertSibling) |
| `indent` / `outdent` / `removeNode` | prior                    | prior                                                   |
| `moveNode`                          | `planMoveNode`           | Cmd+Shift+↑/↓ via moveUp/moveDown → moveNode            |
| `setText`                           | `planSetText`            | prior                                                   |
| `setCompleted`                      | `planSetCompleted`       | field toggle                                            |
| `setCollapsed`                      | `planSetCollapsed`       | field toggle                                            |
| `setIsTask`                         | `planSetIsTask`          | clears `kind` (ADR 0045)                                |
| `setKind`                           | `planSetKind`            | clears `isTask` (ADR 0045)                              |
| `setBookmarkedAt`                   | `planSetBookmarkedAt`    | bookmark pin/unpin                                      |
| `seedIfEmpty` / `hello`             | prior                    | prior                                                   |

### Flag-swap architecture

```
Flag OFF (default):
  OutlineEditor → mutations/runStructural → nodesCollection → /api/sync + UserOutlineDO

Flag ON:
  LunoraSyncHost → createOutlineStore(wholeOutline + bindMutators)
       ↓ subscribeChanges
  tree-store.resetTreeFromNodes (ADR 0004 feed)
       ↑
  mutations (insert/indent/outdent/remove/move/split/field toggles) → Lunora mutators
  runStructural → body only (watermark hold is checkpoints, not waitForSeq)
```

| File                                  | Role                                                    |
| ------------------------------------- | ------------------------------------------------------- |
| `src/data/flags.ts`                   | `isLunoraSyncEnabled()`                                 |
| `src/data/lunora-client.ts`           | singleton `LunoraClient` → same-origin `/_lunora`       |
| `src/data/lunora-outline-store.ts`    | `lunoraCollectionOptions` + `bindMutators` (spike port) |
| `src/data/lunora-bridge.ts`           | rows → TreeIndex / Node                                 |
| `src/data/lunora-sync.ts`             | start/stop, feed tree-store, seedIfEmpty                |
| `src/components/lunora-sync-host.tsx` | AuthGate child; LunoraProvider when flag ON             |
| `src/data/collection.ts`              | flag ON → skip `/api/sync` socket                       |
| `src/data/structural.ts`              | flag ON → no `{ops}` / waitForSeq                       |
| `src/data/mutations.ts`               | Lunora mutator surface (insert/move/split/fields)       |
| `src/data/outline-plans/`             | shared pure planners + unit tests                       |
| `lunora/mutators.ts`                  | server `defineMutator` twin                             |

### Deps (root, bun)

- `@lunora/db@1.0.0-alpha.27`, `@lunora/react@1.0.0-alpha.31`
- `@tanstack/db@^0.6.16`, `@tanstack/offline-transactions@^1.0.41`
- Existing: `lunorash@1.0.0-alpha.98`

### Prior slice (still true)

- Shared planners: `src/data/outline-plans/`
- Worker compose: `/_lunora` → `ShardDO` beside `UserOutlineDO`
- Identity: product Better Auth → Lunora `resolveIdentity`

## Known gaps (flag ON)

- **Not ported:** multi-select batches, daily get-or-create, mirrors (`resolveMirror` path), drag-specific UX (moveNode mutator covers the fuse), OPML, history restore, full plugin structural paths
- **e2e** still on old wire (`seedOutline`); flag must stay OFF for Playwright
- **KV** side-collections still custom DO (phase 2b)
- **No data migrate** from UserOutlineDO → Lunora shard yet (flag ON = empty/new Lunora outline)
- Tree-store Lunora feed is **full rebuild** per change (fine for dogfood; not the incremental hot path)

## Gates (flag OFF)

```sh
bun run typecheck
bun run typecheck:worker
bun run test                    # includes flags + lunora-bridge + outline-plans
```

## Next

1. Lunora-aware e2e fixture (mock `/_lunora` or Miniflare) — keep `seedOutline` until then.
2. KV phase 2b; MCP remount; snapshot migrate; delete `UserOutlineDO` custom sync.
3. Multi-select / daily / mirrors when cutover nears.
4. Green gates → PR; **delete this `HANDOFF.md` in the shipping PR.**

## Note

Root Dotflowy = bun. Spike = pnpm only inside `spikes/lunora-outline`.
