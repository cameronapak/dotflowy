# 01 — nodes transport core (Effect)

Status: BUILT + green. Risk: LOW. Depends on: nothing. Unblocks: 02, 03.
Shipped: `src/data/nodes-client-effect.ts` (core) + `src/data/nodes-client-effect.test.ts` (7 tests);
`api.ts` re-shelled over it (public signatures unchanged; `batchTail`/field coalescer preserved for 02).
Gates: unit 124/124, app+test typecheck clean, lint clean, `atomic-structural-writes.spec.ts` 3/3.

See [PRD](../PRD.md) for the why. This is the foundation: give `/api/nodes` the resilience
`kv-client-effect.ts` already gives `/api/kv`.

## Scope

- **New `src/data/nodes-client-effect.ts`** mirroring `kv-client-effect.ts`:
  - Tagged errors: `NodesTransportError | NodesResponseError | NodesTimeoutError`
    (`Data.TaggedError`).
  - One `request` effect: `Effect.tryPromise` over `fetch` (pass the runtime `signal`),
    `Effect.timeoutOrElse` (8s → `NodesTimeoutError`), `Effect.retry(Schedule.both(exponential(100ms),
    recurs(4)))`, `res.ok` → `NodesResponseError` on non-2xx. Same shape as `kv-client-effect.ts:81`.
  - `sendE(method, body)` → `Effect<void, …>`; `sendBatchE(ops)` → `Effect<{ seq: number }, …>` that
    **validates the `{ seq }` envelope** before returning (mirror `kvGetOrCreateE`'s envelope guard,
    `kv-client-effect.ts:188`) — a non-object / missing `seq` coerces to a transport error, killing the
    `waitForSeq(undefined)` hang.
  - Retry transport failures only, **not** 4xx/5xx (a 500 is deterministic; retrying amplifies a broken
    write) — same policy and comment as the kv core.
- **Re-shell `src/data/api.ts`** over the core, throw-signatures unchanged:
  `createNodes`/`updateNodes`/`persistBatch`/`deleteNodes` keep returning rejecting `Promise`s via
  `runPromise` (reuse the existing `runPromise` bridge or a local twin). `send`/`sendBatch` raw-fetch
  helpers are deleted.
- The hand-rolled coordination (`batchTail`, field coalescer) **stays as-is in this issue** — it now
  calls the Effect-backed core instead of raw `sendBatch`/`send`. Converting the coordination itself is
  issue 02.

## Acceptance

- Unit test with an injectable fake transport (the `kv`/`realtime` idiom): a 5xx surfaces the typed
  error and **does not** retry; a transport drop retries to the cap then fails typed; a timeout yields
  `NodesTimeoutError`; a malformed `{ seq }` body fails typed (not `undefined` success).
- `api.ts` public signatures byte-identical; TanStack rollback path unchanged (a thrown rejection still
  rolls back). Existing structural/field e2e green.
- typecheck + typecheck:test + lint + unit green.

## Idempotency: RESOLVED — batch retry is safe

Checked `worker/outline-do.ts`. Every node op is **absolute, not relative**:
- `putNode` (`:177`) = `INSERT ... ON CONFLICT(id) DO UPDATE SET` over the full node value → re-apply
  writes identical values, no PK-conflict 500.
- `deleteNodeRow` (`:204`) = `DELETE WHERE id = ?` → no-op on a missing row, no throw.
- `applyBatch` comment (`:228`): ops are "absolute (keyed by id), so the final state is
  order-independent."

The only case retry fires on (transport failure = no response, e.g. committed-but-lost-ack) re-applies
idempotently. Sole side effect: one redundant `seq` bump + changelog frame + broadcast, which other
clients re-apply as the same idempotent upsert (bounded by the changelog prune). No corruption path.

**Therefore: use the kv core's retry policy verbatim — retry transport failures, never retry a received
4xx/5xx.** No batch-retry special-casing needed.

## Watch-outs

- The throw-shell must reject the same way the old `new Error` did, or TanStack rollback changes
  behavior. Keep the `mapError → Error` bridge.
- `kv-client-effect.ts` calls global `fetch` directly and has no unit test. To meet this issue's
  testability bar, inject `fetch` as an Effect service (a tiny Layer; prod = global fetch, test = fake)
  — the `realtime.ts` Socket-as-service pattern. That's a deliberate, small divergence from the kv core;
  backporting the same seam to kv is a later symmetry cleanup, not part of 01.
