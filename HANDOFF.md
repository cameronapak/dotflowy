# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

`phase-2-cutover` — ADR 0055 accepted; spike Phase 0–1 proven. **No PR until Lunora cutover is complete and pre-existing tests are 100% green.**

Commits (recent): through `40a5004bb2` (seed smoke) + upcoming ADR 0055 commit.

## Sources of truth

- **ADR 0055:** `docs/adr/0055-lunora-replaces-custom-outline-sync.md` (cutover sequence)
- Spike README: `spikes/lunora-outline/README.md`
- ADRs: `0004`, `0008` (amended by 0055), `0009`, `0055`
- Research clone (machine-local): `/tmp/lunora-research` (`alpha` branch)

## Tree state

- `nodes` schema + `wholeOutline` shape + Better Auth via `defineApp().auth()` + `authorizeShard: identity.userId === shardKey`
- Pure planners in `src/outline/` with vitest chain invariant
- Dual mutator APIs: server `lunorash/server` defineMutator; client `@lunora/db/mutators` defineMutator+bindMutators (shared `plan*`)
- Shared `rowToNode`/`docToNode` + `nodeToDocFields`/`nodeToRow`/`nodeToInsertFields` in `src/outline/map-node.ts`
- Bridge: `src/outline/lunora-bridge.ts` — Lunora collection rows → Dotflowy-shaped `TreeIndex` / ordered children (ADR 0004 handoff; feed tree-store later; **no** OutlineEditor port)
- Seed: `planSeedIfEmpty` + server `seedIfEmpty` mutator with fixed `DEMO_SEED_IDS`; DO watermark FIFO = multi-tab idempotency (second call no-ops)
- Tiny list UI renders via bridge; email/password auth gate; empty copy distinguishes seed-pending vs truly empty
- Scaffold cruft trimmed (unused Vite assets, App.css, welcome CSS, public/icons.svg)
- `.dev.vars` gitignored (do not commit)

## Phase 1 review

- **Must-fix (done):** multi-tab both calling client `insertSibling` seed → duplicate chains. Replaced with server-authoritative `seedIfEmpty`.
- **Should-fix (done):** unify outbound map; empty UI copy; HANDOFF commit list + status.

## Verify

```sh
cd spikes/lunora-outline
pnpm test
pnpm build
pnpm dev   # smoke; note printed Local port
```

### Manual checklist — PASS (2026-07-23)

Verified on `http://localhost:5175/` (Vite fell through 5173→5174→5175):

- [x] Two tabs, same user: live convergence without refresh (~2.5s)
- [x] Hard reload restores outline from shape seed
- [x] Cross-user: second account sees only its own seed, not first user’s bullets
- [x] Fresh-user `seedIfEmpty` smoke (`:5175`): signup → 4 demo bullets; reload stays 4; insert+reload keeps 5 (no double-seed) — after `e16cd6e845`

## API surprises vs docs

- Shape `where` deny is `{ OR: [] }`, not boolean `false` (typed `WhereInput`)
- Codegen Doc/Insert types currently erase `.nullable()` (runtime still accepts null; cast at boundaries via `rowToNode`)
- Advisor `table_without_insert` fires for mutator-only inserts (ignore for this spike)
- Dual `defineMutator` APIs must not be mixed (server vs `@lunora/db/mutators`)

## Code review (Phase 0)

**Standards** — process-clean for a spike. Merge-to-`main` gates: delete this `HANDOFF.md`; add changeset (`bunx changeset --empty` if spike isn't product news). Mild smells addressed in Phase 1: `docToNode`≈`rowToNode` dup → shared helper; leftover Vite assets/CSS trimmed.

**Spec** — required implementation met. Must-prove #1 automated; #2–#5 wired + **manual PASS** (see checklist above). Bridge order covered by unit test.

## Next

- Phase 2 sequence (ADR 0055): lift shared planners → integrate Lunora into main app → swap `nodesCollection` → migrate kv/MCP/data → delete custom DO sync → green gates → **then** PR
- Delete this `HANDOFF.md` in the shipping PR (must never reach `main`)
- Changeset at PR time (likely major communicative bump — readers relearn sync/infra story)

## Note

Root Dotflowy = bun. Always `cd spikes/lunora-outline` before any `pnpm` command.
