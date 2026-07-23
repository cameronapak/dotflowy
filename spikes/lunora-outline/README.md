# Lunora outline spike (Phase 0)

Proof that Dotflowy outline semantics can run on Lunora (shapes + mutators + watermark) **without** Dotflowy’s custom `{ops}` sync.

## Purpose

Greenfield Vite + React Lunora app with outline nodes, structural mutators (`plan*` shared client+server), and ADR 0009-style optimistic hold until server watermark confirm (via `@lunora/db` checkpoints — not a hand-rolled `waitForSeq`).

Constraining ADRs (repo root):

- [ADR 0008 — Sync via a per-user Durable Object](../../docs/adr/0008-sync-via-a-per-user-durable-object.md)
- [ADR 0009 — Atomic structural writes](../../docs/adr/0009-atomic-structural-writes.md)

## How to run

**Always run pnpm from this directory.** Root Dotflowy uses bun (`packageManager: bun@…`); pnpm belongs only here.

```sh
cd spikes/lunora-outline
pnpm install
pnpm codegen   # after schema/mutator changes
pnpm test      # planner chain-invariant unit tests
pnpm dev       # Vite + Worker (default :5173; next free port if busy)
```

Other scripts: `pnpm build`, `pnpm lint`, `pnpm preview`.

Local secrets: `.dev.vars` is gitignored. Scaffold needs `AUTH_SECRET` (and optional `LUNORA_ADMIN_TOKEN` for Studio). Copy patterns from `.env.example` / existing `.dev.vars`.

## Demo: two-tab live sync

1. `pnpm dev` → open the Local URL (e.g. `http://localhost:5174/`).
2. **Sign up** once (`spike@dotflowy.local` / `spike-dev-password` prefilled — change as you like).
3. Insert a few bullets; indent/outdent/delete/edit text.
4. Open a **second tab** to the same origin (already signed in via cookie).
5. Edits in either tab should converge live (shape poke + watermark).
6. Hard reload either tab — outline restores from `wholeOutline` seed.

Cross-user: sign out → sign up as a different email → that session’s `authorizeShard` only allows `identity.userId === shardKey`, so the other user’s outline is unreachable.

## Exit criteria

1. Sibling-chain invariant under rapid structural edits (planner unit tests) — **covered** (`pnpm test`)
2. Two browsers, same user: live convergence without refresh — **manual** (steps above)
3. Optimistic overlay held until server watermark confirm (ADR 0009 P2 analogue) — **wired** via `lunoraCollectionOptions` checkpoints → `bindMutators`
4. Cross-user shard access denied (`authorizeShard: identity.userId === shardKey`) — **wired**
5. Hard reload restores outline from shape seed — **manual**

## Layout

| Path                   | Role                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `lunora/schema.ts`     | `nodes` table (Dotflowy field parity), `.shardBy("userId")`             |
| `lunora/shapes.ts`     | `wholeOutline` owner-gated shape                                        |
| `lunora/mutators.ts`   | Server `defineMutator` (`lunorash/server`) — authoritative              |
| `src/outline/`         | Pure `plan*` + sibling-chain (shared)                                   |
| `src/outline-store.ts` | Client `lunoraCollectionOptions` + `@lunora/db/mutators` `bindMutators` |
| `src/App.tsx`          | Auth gate + tiny outline list UI                                        |

## Pinned Lunora packages

| Package             | Version          |
| ------------------- | ---------------- |
| `lunorash`          | `1.0.0-alpha.98` |
| `@lunora/db`        | `1.0.0-alpha.27` |
| `@lunora/react`     | `1.0.0-alpha.31` |
| `@lunora/auth`      | `1.0.0-alpha.36` |
| `@lunora/ratelimit` | `1.0.0-alpha.9`  |
| `@lunora/vite`      | `1.0.0-alpha.78` |
| `@lunora/studio`    | `1.0.0-alpha.58` |
| `packageManager`    | `pnpm@11.9.0`    |
