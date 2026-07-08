import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { makeNode, type Node } from '../src/data/tree'
import type { ChangeOp } from '../src/data/wire-schema'
import { runQuickAdd } from './quick-add'

/** Minimal in-memory OutlineStore for pure quick-add tests. */
function makeStore(seed: Node[] = []) {
  const nodes = new Map(seed.map((n) => [n.id, n]))
  const kv = new Map<string, Map<string, unknown>>()
  let seq = 0

  return {
    getNodes: () => [...nodes.values()],
    applyBatch: (ops: readonly ChangeOp[]) => {
      for (const op of ops) {
        if (op.op === 'delete') nodes.delete(op.key)
        else nodes.set(op.value.id, op.value)
      }
      seq += 1
      return seq
    },
    getKv: (collection: string) => [...(kv.get(collection)?.values() ?? [])],
    getOrCreateKv: (collection: string, key: string, value: unknown) => {
      let col = kv.get(collection)
      if (!col) {
        col = new Map()
        kv.set(collection, col)
      }
      if (!col.has(key)) col.set(key, value)
      return col.get(key)!
    },
    // Test helpers
    _nodes: nodes,
    _seq: () => seq,
  }
}

describe('runQuickAdd', () => {
  test('rejects empty text', async () => {
    const store = makeStore()
    const result = await Effect.runPromise(Effect.result(runQuickAdd(store, { text: '   ' })))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.status).toBe(400)
    }
  })

  test('appends under an explicit parent', async () => {
    const parent = makeNode({ id: 'p1', text: 'Parent' })
    const store = makeStore([parent])
    const result = await Effect.runPromise(
      runQuickAdd(store, { text: 'Buy milk', parentId: 'p1' }),
    )
    expect(result.parentId).toBe('p1')
    expect(result.seq).toBe(1)
    const inserted = store._nodes.get(result.id)
    expect(inserted?.text).toBe('Buy milk')
    expect(inserted?.parentId).toBe('p1')
    expect(inserted?.origin).toBe('quick-add')
  })

  test('404 when parent is missing', async () => {
    const store = makeStore()
    const result = await Effect.runPromise(
      Effect.result(runQuickAdd(store, { text: 'x', parentId: 'missing' })),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.status).toBe(404)
    }
  })

  test('defaults to daily note when parentId is omitted', async () => {
    const store = makeStore()
    const result = await Effect.runPromise(
      runQuickAdd(store, { text: 'Inbox item', date: '2026-07-08' }),
    )
    expect(result.parentId).toBeTruthy()
    expect(result.seq).toBe(1)
    const inserted = store._nodes.get(result.id)
    expect(inserted?.text).toBe('Inbox item')
    expect(inserted?.parentId).toBe(result.parentId)
    // Day + container scaffolding + bullet can be multiple ops in one batch,
    // but one applyBatch call → seq 1.
    expect(store._nodes.size).toBeGreaterThanOrEqual(2)
  })
})
