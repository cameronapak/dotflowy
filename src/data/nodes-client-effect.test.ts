import { afterEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import {
  createNodesE,
  deleteNodesE,
  NodesResponseError,
  runPromise,
  sendBatchE,
} from './nodes-client-effect'

// The transport core is verbatim from kv-client-effect.ts (proven in prod), so
// these tests pin only what 01 ADDS: the `{ seq }` envelope validation, the
// error-channel mapping, the no-retry-on-response policy, and the throw bridge.
// They stub global `fetch` (the realtime.test.ts seam idiom) and never wait out
// a real backoff/timeout — none of the asserted paths enter the retry schedule.

const realFetch = globalThis.fetch
let calls = 0

/** Install a fetch that returns `make()` and counts invocations. */
function stubFetch(make: () => Response): void {
  calls = 0
  globalThis.fetch = (() => {
    calls += 1
    return Promise.resolve(make())
  }) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('sendBatchE', () => {
  test('returns { seq } on a valid envelope', async () => {
    stubFetch(() => new Response(JSON.stringify({ seq: 7 }), { status: 200 }))
    expect(await runPromise(sendBatchE([]))).toEqual({ seq: 7 })
    expect(calls).toBe(1)
  })

  test('fails NodesTransportError on a missing seq', async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const err = await Effect.runPromise(Effect.flip(sendBatchE([])))
    expect(err._tag).toBe('NodesTransportError')
  })

  test('fails NodesTransportError on a non-JSON 200 (proxy HTML)', async () => {
    stubFetch(() => new Response('<html>nope</html>', { status: 200 }))
    const err = await Effect.runPromise(Effect.flip(sendBatchE([])))
    expect(err._tag).toBe('NodesTransportError')
  })

  test('fails NodesResponseError on 5xx and does NOT retry', async () => {
    stubFetch(() => new Response('boom', { status: 500 }))
    const err = await Effect.runPromise(Effect.flip(sendBatchE([])))
    expect(err._tag).toBe('NodesResponseError')
    expect((err as NodesResponseError).status).toBe(500)
    expect(calls).toBe(1) // a received response is never retried
  })
})

describe('createNodesE / deleteNodesE', () => {
  test('resolve void on 2xx', async () => {
    stubFetch(() => new Response(null, { status: 200 }))
    await runPromise(createNodesE([]))
    await runPromise(deleteNodesE([]))
    expect(calls).toBe(2)
  })

  test('createNodesE fails NodesResponseError on 5xx', async () => {
    stubFetch(() => new Response('err', { status: 503 }))
    const err = await Effect.runPromise(Effect.flip(createNodesE([])))
    expect(err._tag).toBe('NodesResponseError')
  })
})

describe('runPromise bridge', () => {
  test('rejects (throws) on a typed failure, for TanStack rollback', async () => {
    stubFetch(() => new Response('err', { status: 500 }))
    await expect(runPromise(sendBatchE([]))).rejects.toThrow()
  })
})
