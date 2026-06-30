import { afterEach, describe, expect, test } from 'bun:test'
import { persistBatch } from './api'
import type { ChangeOp } from './realtime'

// Pins the structural-batch serialization (the `writeSem` semaphore in api.ts):
// rapid batches must NOT overlap on the wire (else the DO can reorder them and
// re-tear a sibling chain — ADR 0009), and a failed batch must not wedge the
// queue. A controllable fetch parks each request until the test resolves it, so
// we observe send order directly (the unit twin of the e2e `postDelayMs` seam).

const realFetch = globalThis.fetch

interface Pending {
  body: string
  resolve: (r: Response) => void
}
let pending: Pending[] = []

function installControlledFetch(): void {
  pending = []
  globalThis.fetch = ((_url: string, init: { body?: unknown }) =>
    new Promise<Response>((resolve) => {
      pending.push({ body: String(init.body), resolve })
    })) as unknown as typeof fetch
}

/** A pending request, narrowed away from undefined (noUncheckedIndexedAccess). */
function at(i: number): Pending {
  const p = pending[i]
  if (!p) throw new Error(`expected a pending request at index ${i}`)
  return p
}

/** Let parked fibers advance (semaphore acquire → fetch fire) on a real tick. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))
const ok = (seq: number): Response =>
  new Response(JSON.stringify({ seq }), { status: 200 })
const op = (key: string): ChangeOp => ({ op: 'delete', key })

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('persistBatch serialization (writeSem)', () => {
  test('a second batch stays off the wire until the first responds', async () => {
    installControlledFetch()
    const p1 = persistBatch([op('a')])
    const p2 = persistBatch([op('b')])
    await tick()

    // Only batch A is in flight; B is parked on the semaphore.
    expect(pending.length).toBe(1)
    expect(at(0).body).toContain('"a"')

    at(0).resolve(ok(1))
    await tick()

    // A's response lands → B's request now leaves the client, in order.
    expect(pending.length).toBe(2)
    expect(at(1).body).toContain('"b"')

    at(1).resolve(ok(2))
    expect(await p1).toEqual({ seq: 1 })
    expect(await p2).toEqual({ seq: 2 })
  })

  test('a failed batch rejects its caller but does not wedge the next', async () => {
    installControlledFetch()
    const p1 = persistBatch([op('a')])
    const p2 = persistBatch([op('b')])
    await tick()
    expect(pending.length).toBe(1)

    // A 5xx is a received response (not a transport drop), so it never retries.
    at(0).resolve(new Response('boom', { status: 500 }))
    await expect(p1).rejects.toThrow()
    await tick()

    // The permit released on failure → B proceeded.
    expect(pending.length).toBe(2)
    at(1).resolve(ok(2))
    expect(await p2).toEqual({ seq: 2 })
  })
})
