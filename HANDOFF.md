# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

`phase-0-implemented` — schema, planners+tests, structural mutators, minimal multi-tab UI.

Commits on `spike/lunora-outline` after scaffold `f953b17350`:

1. `6a171ddf2f` `feat(spike): nodes schema, wholeOutline shape, auth shard gate`
2. `c840ad1939` `feat(spike): pure outline planners + chain invariant tests`
3. `d5d71189af` `feat(spike): structural mutators + minimal multi-tab outline UI`

## Sources of truth

- Spike README: `spikes/lunora-outline/README.md` (run / demo / exit criteria)
- ADRs: `docs/adr/0008-…`, `docs/adr/0009-…`
- Research clone (machine-local): `/tmp/lunora-research` (`alpha` branch)

## Tree state

- `nodes` schema + `wholeOutline` shape + Better Auth via `defineApp().auth()` + `authorizeShard: identity.userId === shardKey`
- Pure planners in `src/outline/` with vitest chain invariant
- Dual mutator APIs: server `lunorash/server` defineMutator; client `@lunora/db/mutators` defineMutator+bindMutators (shared `plan*`)
- Tiny list UI + email/password auth gate
- `.dev.vars` gitignored (do not commit)

## Verify

```sh
cd spikes/lunora-outline
pnpm test
pnpm build
pnpm dev   # smoke; note printed Local port
```

## API surprises vs docs

- Shape `where` deny is `{ OR: [] }`, not boolean `false` (typed `WhereInput`)
- Codegen Doc/Insert types currently erase `.nullable()` (runtime still accepts null; cast at boundaries)
- Advisor `table_without_insert` fires for mutator-only inserts (ignore for this spike)
- Dual `defineMutator` APIs must not be mixed (server vs `@lunora/db/mutators`)

## Next (post Phase 0)

- Manual 2-tab + hard-reload checklist against exit criteria
- Optional: seed helper / Studio path for faster demos
- Phase 1+: richer editor / migrate product surfaces — out of scope here

## Note

Root Dotflowy = bun. Always `cd spikes/lunora-outline` before any `pnpm` command.
