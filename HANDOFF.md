# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

`phase-2-compose` — shared planners lifted; Lunora `SHARD` DO composed beside `UserOutlineDO`. Product `/api/*` + ASSETS + MCP unchanged. **No PR until collection cutover + gates green.**

## What landed (this slice)

### A. Shared planners → `src/data/outline-plans/`

- Pure `plan*` / `seed` / `map-node` / types; converges on Dotflowy `Node` + `tree.ts` / `sibling-chain.ts` (`OutlineNode = Node & { userId }`).
- Unit tests: `src/data/outline-plans/*.test.ts` (`bun run test`).
- Spike imports via Vite/vitest alias `@dotflowy/outline-plans` → `../../src/data/outline-plans` (see `spikes/lunora-outline/vite.config.ts`). Awkward bit: root `bun test` filter `src` used to also match `spikes/**/src/**` — script is now `bun test -- ./src ./worker`. Spike still runs `pnpm test` (vitest) in its directory.

### B. Lunora compose in main Worker

- Root deps: `lunorash@1.0.0-alpha.98`, `@lunora/ratelimit@1.0.0-alpha.9` (bun).
- Schema/mutators: repo-root `lunora/` (nodes + `wholeOutline` + spike mutators + `hello` smoke mutator). Codegen: `bun run lunora:codegen`.
- `wrangler.jsonc`: `SHARD` → `ShardDO` **alongside** `USER_OUTLINE`; migration tag `v2`.
- `worker/lunora-app.ts`: `defineApp` + product Better Auth `resolveIdentity` bridge (no `@lunora/auth` dual signup).
- `worker/index.ts`: `/_lunora` → `lunoraApp.fetch`; Vite proxies `/_lunora` → `:8787`.

### Temporary escapes (typecheck)

- `ShardDO` is **not** Sentry-wrapped — Lunora `ShardDOState.sql` typing doesn't satisfy Sentry's `DurableObjectState` constraint. Revisit when wrapping or types align.

## Sources of truth

- **ADR 0055:** `docs/adr/0055-lunora-replaces-custom-outline-sync.md`
- Spike README: `spikes/lunora-outline/README.md`
- Shared planners: `src/data/outline-plans/`
- Research clone (machine-local): `/tmp/lunora-research` (`alpha` branch)

## Compose smoke

```sh
bun run lunora:codegen          # after lunora/ schema/mutator edits
bun run typecheck
bun run typecheck:worker
bun run test                    # includes outline-plans; excludes spike vitest
cd spikes/lunora-outline && pnpm test

# Product path (custom DO still authoritative for OutlineEditor):
bun run dev
# Optional: curl Worker status once api is up
# curl -sS http://localhost:8787/_lunora/status
```

Spike alone still: `cd spikes/lunora-outline && pnpm dev`.

## Next

1. **Flag-swap / collection cutover** — `nodesCollection` → `@lunora/db` shape collections; structural path → `bindMutators` (ADR 0055 seq step 4).
2. Keep `seedOutline` e2e as-is until that swap.
3. KV side-collections = phase **2b** (don't block on them).
4. Then MCP remount / data migrate / delete `UserOutlineDO` custom sync → green gates → PR.
5. Delete this `HANDOFF.md` in the shipping PR.

## Note

Root Dotflowy = bun. Spike = pnpm only inside `spikes/lunora-outline`.
