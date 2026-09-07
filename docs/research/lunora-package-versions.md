# Research: Lunora package versions (2026-09-07 update)

Gathered 2026-09-07 while bumping Dotflowy's direct Lunora dependencies to latest. Records what the update changed, the one breaking API change it forced, and how the `@lunora/*` family versions couple.

Sources: [npm registry](https://registry.npmjs.org) (`npm view` for dist-tags, `dependencies`, `time`), shipped type declarations on [unpkg](https://unpkg.com) (`@lunora/runtime@1.0.0-alpha.62` and `@1.0.0-alpha.102`, `dist/index.d.ts`), [anolilab/lunora GitHub releases](https://github.com/anolilab/lunora/releases), and this repo's own verification runs (`tsc`, `bun test`, regenerated `lunora/_generated/`).

## 1. Summary

| Package             | Was               | Now               | Latest publish | Breaking for this repo | Notes                                                                               |
| ------------------- | ----------------- | ----------------- | -------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `@lunora/db`        | `1.0.0-alpha.52`  | `1.0.0-alpha.90`  | 2026-09-07     | No                     | Peer deps unchanged: `@tanstack/db ^0.6.0`, `@tanstack/offline-transactions ^1.0.0` |
| `@lunora/ratelimit` | `1.0.0-alpha.22`  | `1.0.0-alpha.44`  | 2026-09-07     | No                     | Matches the version `lunorash@alpha.237` pins                                       |
| `@lunora/react`     | `1.0.0-alpha.53`  | `1.0.0-alpha.92`  | 2026-09-07     | No                     | Peers unchanged: `react ^19.2.7`, `@tanstack/react-query ^5.101.0`                  |
| `lunorash`          | `1.0.0-alpha.166` | `1.0.0-alpha.237` | 2026-09-07     | Yes (one)              | `authorizeShard` signature change, via `@lunora/runtime` (see §3)                   |

The `latest` dist-tags are `0.0.0`/`0.0.1` placeholders for all four packages; the live channel is `alpha` (npm `dist-tags`, checked 2026-09-07).

## 2. The family moves in lockstep

The `@lunora/*` packages exact-pin each other (no ranges). Verified from `npm view` dependency manifests:

- `@lunora/db@1.0.0-alpha.90` and `@lunora/react@1.0.0-alpha.92` both depend on `@lunora/client@1.0.0-alpha.87` and `@lunora/errors@1.0.0-alpha.35`.
- `lunorash@1.0.0-alpha.237` depends on `@lunora/client@1.0.0-alpha.87`, `@lunora/errors@1.0.0-alpha.35`, and `@lunora/ratelimit@1.0.0-alpha.44` — exactly the pin we took.

So upgrading the four direct deps together (as this update did) is the safe move; cherry-picking one of them risks skew against the intra-family pins.

## 3. The one breaking change: `authorizeShard`

`@lunora/runtime` changed the `WorkerOptions.authorizeShard` signature between `1.0.0-alpha.62` (what `lunorash@alpha.166` pulled) and `1.0.0-alpha.102` (what `lunorash@alpha.237` pulls). Verified from the shipped declarations:

- Old (`@lunora/runtime@1.0.0-alpha.62`, `dist/index.d.ts:3516`): `authorizeShard?: (identity: ResolvedIdentity | null, shardKey: string) => boolean | Promise<boolean>`
- New (`@lunora/runtime@1.0.0-alpha.102`, `dist/index.d.ts:3696`, `ShardCaller` at `:3545`): `authorizeShard?: (caller: ShardCaller) => boolean | Promise<boolean>` where `ShardCaller = { identity: ResolvedIdentity | null; shardKey: string }`

Same semantics, one object parameter instead of two. Fixed in this repo in `worker/lunora-app.ts`: `(caller) => caller.identity?.userId === caller.shardKey`. The `ShardCaller` doc comment also clarifies that `identity: null` means an unauthenticated end user (internal dispatch never reaches the gate), so `null` still denies.

The exact release that flipped this was not pinpointed (the repo has 100+ pages of per-package releases); the before/after artifacts above are the source of truth.

## 4. New opt-in surface from regenerated codegen

`bun run lunora:codegen` under the new CLI rewrote `lunora/_generated/` (largest: `shard.ts`, `app.ts`). The `AppBuilder` gained builder methods, all opt-in and unused here: `.cdc()` (change-data-capture into `__cdc_log`, required for shard-local `defineShape`), `.reactiveCache()` (per-shard query memoization invalidated pre-broadcast), `.maxRelationKeys()`, `.observability()` (telemetry sink for the DO half), `.relationExistsPushDown()`. Nothing existing was removed from the generated surface this repo uses.

## 5. What the update did not break

Evidence, not inference: `tsc --noEmit` (root, `worker/`, test configs) passes, `oxlint` shows only pre-existing warnings, and all 1037 unit tests across 65 files pass after the update plus the one-line `authorizeShard` fix. `@lunora/db` (TanStack DB collection binding), `@lunora/react` (`LunoraClient`/provider/hooks), and `@lunora/ratelimit` surfaces this repo uses are type-compatible across the covered ranges.

## 6. Unrelated flag worth its own follow-up

The newer codegen advisor surfaced a pre-existing repo issue: `plaintext_secret_in_wrangler_vars` (ERROR) — `SENTRY_DSN` sits in plaintext in `wrangler.jsonc` `vars`. That predates this update; the advisor just got loud enough to say so. Fix is to move it to `wrangler secret put` / Secrets Store and rotate the value.
