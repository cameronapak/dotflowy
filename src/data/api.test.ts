import { afterEach, describe, expect, test } from 'bun:test'
import { persistBatch, updateNodes } from './api'
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

// Pins the field coalescer (the `fieldSem` generations in api.ts): rapid field
// edits serialize + coalesce into one PATCH per round trip, and -- the ADR 0010
// invariant -- every caller that merged into a failed generation rolls back
// together (shared-fate). A field PATCH is `void`-shaped (no `{seq}` body to
// read), so a 200 with any body is success and a 5xx rejects without retrying.
const okField = (): Response => new Response(null, { status: 200 })

describe('updateNodes field coalescer (fieldSem generations)', () => {
  test('shared-fate: both callers of a failed generation reject', async () => {
    installControlledFetch()
    // Gen 1 = A, sent alone (nothing in flight when it arms).
    const pA = updateNodes([{ id: 'a', changes: { text: 'a' } }])
    await tick()
    expect(pending.length).toBe(1)

    // B and C land while gen 1 is in flight -> they share ONE generation.
    const pB = updateNodes([{ id: 'b', changes: { text: 'b' } }])
    const pC = updateNodes([{ id: 'c', changes: { text: 'c' } }])

    at(0).resolve(okField()) // gen 1 ok -> releases the permit
    await tick()
    expect(pending.length).toBe(2) // gen 2 (B+C merged) now in flight
    expect(at(1).body).toContain('"b"')
    expect(at(1).body).toContain('"c"')

    at(1).resolve(new Response('boom', { status: 500 })) // gen 2 fails
    await expect(pB).rejects.toThrow()
    await expect(pC).rejects.toThrow() // shared-fate: C rolls back too
    await expect(pA).resolves.toBeUndefined()
  })

  test('coalesces a burst during the in-flight window into one PATCH', async () => {
    installControlledFetch()
    const pA = updateNodes([{ id: 'a', changes: { text: 'a1' } }])
    await tick()
    expect(pending.length).toBe(1)
    expect(at(0).body).toContain('a1')

    // Burst while gen 1 is in flight: same id twice + a different id.
    updateNodes([{ id: 'a', changes: { text: 'a2' } }])
    updateNodes([{ id: 'a', changes: { text: 'a3' } }])
    updateNodes([{ id: 'b', changes: { text: 'b1' } }])

    at(0).resolve(okField())
    await tick()
    // One PATCH for the whole burst; last-write-wins on `a`, `b` carried along.
    expect(pending.length).toBe(2)
    const body = at(1).body
    expect(body).toContain('a3')
    expect(body).not.toContain('a2') // superseded by a3
    expect(body).toContain('b1')

    at(1).resolve(okField())
    await expect(pA).resolves.toBeUndefined()
  })

  test('a generation does not send before the prior responds', async () => {
    installControlledFetch()
    const pA = updateNodes([{ id: 'a', changes: { text: 'a' } }])
    await tick()
    updateNodes([{ id: 'b', changes: { text: 'b' } }]) // gen 2, parked on permit
    await tick()
    expect(pending.length).toBe(1) // gen 2 stays off the wire

    at(0).resolve(okField())
    await tick()
    expect(pending.length).toBe(2)
    expect(at(1).body).toContain('"b"')
    at(1).resolve(okField())
    await pA
  })

  test('a failed generation does not wedge the next', async () => {
    installControlledFetch()
    const pA = updateNodes([{ id: 'a', changes: { text: 'a' } }])
    await tick()
    const pB = updateNodes([{ id: 'b', changes: { text: 'b' } }]) // gen 2

    at(0).resolve(new Response('boom', { status: 500 })) // gen 1 fails
    await expect(pA).rejects.toThrow()
    await tick()
    expect(pending.length).toBe(2) // permit released -> gen 2 proceeded

    at(1).resolve(okField())
    await expect(pB).resolves.toBeUndefined()
  })

  test('merges field-wise last-write-wins per id', async () => {
    installControlledFetch()
    const pA = updateNodes([{ id: 'a', changes: { text: 'x' } }])
    await tick()
    // During flight: overlapping + new fields on the same id.
    updateNodes([{ id: 'a', changes: { completed: true } }])
    updateNodes([{ id: 'a', changes: { text: 'y' } }])

    at(0).resolve(okField())
    await tick()
    const body = at(1).body // merged: { text: 'y', completed: true }
    expect(body).toContain('"y"')
    expect(body).toContain('completed')
    expect(body).not.toContain('"x"') // text superseded
    at(1).resolve(okField())
    await pA
  })

  test('the first edit hits the wire on a tick, not after a debounce', async () => {
    installControlledFetch()
    const pA = updateNodes([{ id: 'a', changes: { text: 'a' } }])
    await tick() // one scheduler tick, not a timer window
    expect(pending.length).toBe(1)
    at(0).resolve(okField())
    await pA
  })
})
