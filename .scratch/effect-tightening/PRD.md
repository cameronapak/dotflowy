# PRD: Tighten the client async layer onto Effect

Status: In progress — issue 01 (transport core) BUILT + green; 02–04 planned. Posture recorded in
[ADR 0021](../../docs/adr/0021-effect-first-one-schema-language.md) (sharpened: "any effect is Effect;
pure stays pure; the three runtime seams bridge, not exempt"). This PRD is the conversion backlog ADR
0021's consequences point at.

## Why

The kv side-collections (tag colors, daily index) ride a hardened Effect transport core
(`kv-client-effect.ts`: retry + 8s timeout + typed errors + response-shape validation +
AbortSignal). The **primary** data path — the outline itself, `/api/nodes` — does **not**. It is raw
`fetch` with hand-rolled `Promise` coordination. The robustness gradient is inverted: the data that
matters most is the least protected.

Concrete gaps in `src/data/api.ts`:

| Concern | kv path (`kv-client-effect.ts`) | nodes path (`api.ts`) |
| --- | --- | --- |
| Retry/backoff | `Schedule.both(exponential, recurs(4))` (`:62`) | none — a transient blip throws and the optimistic insert/move silently reverts |
| Timeout | 8s → typed `KvTimeoutError` (`:100`) | none — a hung POST never resolves and wedges every later structural edit behind `batchTail` |
| Typed errors | `KvTransportError \| KvResponseError \| KvTimeoutError` | `throw new Error("POST ... -> 500")` (`:27,:36`) |
| Response validation | validates the `{value}` envelope (`:188`) | `res.json() as { seq: number }` — **unchecked cast** (`:37`); a proxy 200-with-HTML makes `seq` undefined and `waitForSeq` hangs to its timeout |
| Cancellation | AbortSignal via the runtime (`:91`) | none |

The coordination around it is hand-rolled concurrency that Effect models natively: `batchTail`
(serialize structural batches, `api.ts:51`) is a `Semaphore(1)`; the field coalescer
(`fieldInFlight`/`fieldPending`/`fieldFlush`, `:97`) is a `Semaphore(1)` + one shared per-generation
promise (NOT `Ref`/`Deferred` — see issue 02); `waitForSeq`/`waitForNode`
(`collection.ts:130,:147`) are `Deferred` + `Effect.timeout`. Plus the scattered edge async the audit
found: `seed.ts` bootstrap, the `fetchLinkTitle` fire-and-forget (no cancellation → can write a deleted
bullet's DOM), and the daily `ensure*` chains.

The goal is **transport parity, not Effect-for-its-own-sake**: give the primary path the resilience the
secondary path already has, and replace hand-rolled Promise machinery with the primitives the codebase
already speaks.

## Locked design

- **The three seams hold** (ADR 0021). TanStack mutation handlers stay throw-shaped (`runPromise`
  bridge); React handlers bridge with `runPromise`/`runFork`; the DO's `transactionSync` is untouched.
  Effect goes all the way down to each seam, not past it.
- **`api.ts` mirrors `kv-api.ts`.** A new `nodes-client-effect.ts` is the Effect core; `api.ts` becomes
  the throw-shell over it via `runPromise`, exactly as `kv-api.ts` shells `kv-client-effect.ts`. The
  public throw signatures (`createNodes`/`updateNodes`/`persistBatch`/`deleteNodes`) do not change.
- **Pure stays pure.** `tree.ts`, `tags.ts`, `links.ts`, `sibling-chain.ts` are not wrapped. The
  dev-only `assertTouchedChainsClean` try/catch (`structural.ts:79`) stays a plain guard — it manages no
  effect, it's an invariant tripwire.
- **The hot path keeps its tuning.** ADRs 0009/0010 tuned the write-ordering machinery deliberately
  (atomic batches, serialize+coalesce, no debounce latency, ignore-own-echo). The Effect rewrite must
  preserve every one of those behaviors; each piece earns a `realtime.test.ts`-style fake-seam test as
  it converts (the injectable-transport seam, mirroring the injectable `WebSocketConstructor`).
- **Bridge once, not per keystroke.** `collection.ts` already forks one long-lived fiber on
  `appRuntime`. Coordination primitives live in that world and bridge at one altitude — no `runPromise`
  sprinkled per field edit.

## Build order (dependency-sequenced, reviewable chunks)

1. **[01 — nodes transport core](./issues/01-nodes-transport-core.md)** — LOW risk, no deps. The
   foundation: `nodes-client-effect.ts` (retry + timeout + typed errors + `{seq}` validation), `api.ts`
   re-shelled over it. Closes the robustness gap and the unchecked-`seq` latent bug on its own.
2. **[02 — write-path coordination](./issues/02-write-path-coordination.md)** — HIGH risk, depends on
   01. `batchTail` → `Semaphore(1)` (DONE); field coalescer → `Semaphore(1)` + shared per-generation
   promise (no `Ref`/`Deferred`). The typing hot path; ADRs 0009/0010 behaviors are the acceptance bar.
   Fake-transport unit tests first.
3. **[03 — echo waiters](./issues/03-echo-waiters.md)** — MED risk, depends on 01 (composes the write
   program end-to-end). `waitForSeq`/`waitForNode` → `Deferred` + `Effect.timeout`. Preserve the
   resolve-on-timeout (seq) vs reject-on-timeout (node) semantics exactly.
4. **[04 — plugin + bootstrap async](./issues/04-plugin-bootstrap-async.md)** — LOW–MED risk,
   independent of 01–03 (can land in parallel). `seed.ts` bootstrap as a full Effect program;
   `fetchLinkTitle` with fiber interruption (fixes write-after-delete); daily `ensure*` + `pending.ts`
   `try/finally` → `Effect.ensuring`.

01 unblocks 02 and 03; 04 is parallel. No mega-PR — each issue is its own diff with its own green gate.

## Acceptance (whole effort)

- `/api/nodes` writes inherit retry + timeout + typed errors + shape validation, proven by
  fake-transport unit tests (the `kv`/`realtime` test idiom).
- No raw `fetch`/`new Promise`/`setTimeout` left in `src/data/` or the plugin async paths for an effect
  Effect models (the ADR 0021 invariant). Verified by grep + the audit list in the issues.
- Every ADR 0009/0010 behavior intact: atomic structural batches, serialize+coalesce field edits with
  no added latency, ignore-own-echo on the focused bullet, optimistic-hold-until-echo. Existing e2e
  (`atomic-structural-writes.spec.ts`, the field-edit specs) green, serial.
- typecheck + typecheck:test + typecheck:worker + lint + unit + e2e green.

## Out of scope

- The Worker handlers' `runPromise().catch()` → HTTP mapping (`worker/index.ts`) — already Effect
  underneath; a separate cleanup if it's worth it, not part of the client tightening.
- Any change to the three seams' *shape* (throw / Promise / `transactionSync`). Bridge, don't leak.
