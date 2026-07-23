# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

`phase-1-bridge` — shared mapping, empty-outline seed, ADR 0004 TreeIndex bridge, scaffold trim.

Commits on `spike/lunora-outline` after Phase 0 docs `78cca687f9`:

_(filled after Phase 1 commits)_

## Sources of truth

- Spike README: `spikes/lunora-outline/README.md` (run / demo / exit criteria)
- ADRs: `docs/adr/0004-…`, `docs/adr/0008-…`, `docs/adr/0009-…`
- Research clone (machine-local): `/tmp/lunora-research` (`alpha` branch)

## Tree state

- `nodes` schema + `wholeOutline` shape + Better Auth via `defineApp().auth()` + `authorizeShard: identity.userId === shardKey`
- Pure planners in `src/outline/` with vitest chain invariant
- Dual mutator APIs: server `lunorash/server` defineMutator; client `@lunora/db/mutators` defineMutator+bindMutators (shared `plan*`)
- Shared `rowToNode`/`docToNode` in `src/outline/map-node.ts` (used by mutators + outline-store + App)
- Bridge: `src/outline/lunora-bridge.ts` — Lunora collection rows → Dotflowy-shaped `TreeIndex` / ordered children (ADR 0004 handoff; feed tree-store later; **no** OutlineEditor port)
- Seed: `src/outline/seed.ts` — on first ready+empty load, 4 demo bullets via `insertSibling` (idempotent)
- Tiny list UI renders via bridge; email/password auth gate
- Scaffold cruft trimmed (unused Vite assets, App.css, welcome CSS, public/icons.svg)
- `.dev.vars` gitignored (do not commit)

## Verify

```sh
cd spikes/lunora-outline
pnpm test
pnpm build
pnpm dev   # smoke; note printed Local port
```

### Manual checklist (still required)

- [ ] Two tabs, same user: live convergence without refresh
- [ ] Hard reload restores outline (incl. seeded demo bullets)
- [ ] Optional: second user cannot see first user’s outline

## API surprises vs docs

- Shape `where` deny is `{ OR: [] }`, not boolean `false` (typed `WhereInput`)
- Codegen Doc/Insert types currently erase `.nullable()` (runtime still accepts null; cast at boundaries via `rowToNode`)
- Advisor `table_without_insert` fires for mutator-only inserts (ignore for this spike)
- Dual `defineMutator` APIs must not be mixed (server vs `@lunora/db/mutators`)

## Code review (Phase 0)

**Standards** — process-clean for a spike. Merge-to-`main` gates: delete this `HANDOFF.md`; add changeset (`bunx changeset --empty` if spike isn't product news). Mild smells addressed in Phase 1: `docToNode`≈`rowToNode` dup → shared helper; leftover Vite assets/CSS trimmed.

**Spec** — required implementation met. Must-prove #1 automated (planner tests). #2–#5 wired; still need human 2-tab / hard-reload / cross-user pass (README checklist). Bridge order covered by unit test.

## Next

- Manual 2-tab + hard-reload (+ optional second browser / second user) against exit criteria
- Before any PR to `main`: delete `HANDOFF.md` + empty changeset
- Phase 2+: richer editor / migrate product — out of scope here

## Note

Root Dotflowy = bun. Always `cd spikes/lunora-outline` before any `pnpm` command.
