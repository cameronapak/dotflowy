# HANDOFF — spike/lunora-outline

**Delete this file before merging to `main`.** Branch-local build coordination only.

## Status

`scaffolded` — Phase 0 bootstrap done under `spikes/lunora-outline/`.

## Sources of truth

- Spike README: `spikes/lunora-outline/README.md`
- ADRs: `docs/adr/0008-…`, `docs/adr/0009-…`
- Research clone (machine-local): `/tmp/lunora-research` (`alpha` branch)

## Tree state

- Vite + React Lunora scaffold via `pnpm dlx lunorash@alpha init … --vite react`
- Demo schema: `lunora/schema.ts` (`messages` sharded by `channelId`) + ratelimit extension
- Demo mutators: `lunora/messages.ts` (`list` query, `send` mutation)
- `@lunora/db@1.0.0-alpha.27` added; outline shapes/mutators **not** written yet
- `.dev.vars` gitignored (do not commit)

## Next

1. Schema + shapes for outline nodes (sibling chain)
2. Structural mutators + watermark-aware optimistic overlay
3. Client UI exercising live sync / two-tab convergence
4. `authorizeShard: identity.userId === shardKey`

## Note

Root Dotflowy = bun. Always `cd spikes/lunora-outline` before any `pnpm` command.
