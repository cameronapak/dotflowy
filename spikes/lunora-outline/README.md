# Lunora outline spike (Phase 0)

Proof that Dotflowy outline semantics can run on Lunora (shapes + mutators + watermark) **without** Dotflowy’s custom `{ops}` sync.

## Purpose

Greenfield Vite + React Lunora app. Next phases replace the scaffold `messages` demo with outline nodes, structural mutators, and ADR 0009-style optimistic hold until server watermark confirm.

Constraining ADRs (repo root):

- [ADR 0008 — Sync via a per-user Durable Object](../../docs/adr/0008-sync-via-a-per-user-durable-object.md)
- [ADR 0009 — Atomic structural writes](../../docs/adr/0009-atomic-structural-writes.md)

## How to run

**Always run pnpm from this directory.** Root Dotflowy uses bun (`packageManager: bun@…`); pnpm belongs only here.

```sh
cd spikes/lunora-outline
pnpm install
pnpm dev
```

Other scripts: `pnpm build`, `pnpm codegen`, `pnpm lint`, `pnpm preview`.

Local secrets: `.dev.vars` is gitignored (scaffold also ignores `.env` / `.env.*`). Copy from `.env.example` if you need `VITE_LUNORA_URL`.

## Exit criteria

1. Sibling-chain invariant under rapid structural edits (planner unit tests)
2. Two browsers, same user: live convergence without refresh
3. Optimistic overlay held until server watermark confirm (ADR 0009 P2 analogue)
4. Cross-user shard access denied (`authorizeShard: identity.userId === shardKey`)
5. Hard reload restores outline from shape seed

## Pinned Lunora packages

| Package             | Version          |
| ------------------- | ---------------- |
| `lunorash`          | `1.0.0-alpha.98` |
| `@lunora/db`        | `1.0.0-alpha.27` |
| `@lunora/react`     | `1.0.0-alpha.31` |
| `@lunora/ratelimit` | `1.0.0-alpha.9`  |
| `@lunora/vite`      | `1.0.0-alpha.78` |
| `@lunora/studio`    | `1.0.0-alpha.58` |
| `packageManager`    | `pnpm@11.9.0`    |
