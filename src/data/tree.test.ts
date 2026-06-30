import { describe, expect, test } from 'bun:test'
import { buildTrail, buildTreeIndex, childrenOf, makeNode } from './tree'

describe('buildTreeIndex + childrenOf', () => {
  test('orders siblings by the prevSiblingId chain, not input order', () => {
    // a -> b -> c, fed to the index out of order
    const a = makeNode({ id: 'a', prevSiblingId: null })
    const b = makeNode({ id: 'b', prevSiblingId: 'a' })
    const c = makeNode({ id: 'c', prevSiblingId: 'b' })
    const index = buildTreeIndex([c, a, b])

    expect(childrenOf(index, null).map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(index.byId.size).toBe(3)
  })

  test('children are keyed by parentId', () => {
    const p = makeNode({ id: 'p' })
    const k1 = makeNode({ id: 'k1', parentId: 'p', prevSiblingId: null })
    const k2 = makeNode({ id: 'k2', parentId: 'p', prevSiblingId: 'k1' })
    const index = buildTreeIndex([p, k1, k2])

    expect(childrenOf(index, 'p').map((n) => n.id)).toEqual(['k1', 'k2'])
    expect(childrenOf(index, null).map((n) => n.id)).toEqual(['p'])
    expect(childrenOf(index, 'nope')).toEqual([])
  })

  test('a node orphaned by a broken chain is appended, never dropped', () => {
    const p = makeNode({ id: 'p' })
    const x = makeNode({ id: 'x', parentId: 'p', prevSiblingId: null })
    // y points at a sibling that does not exist -> off the chain
    const y = makeNode({ id: 'y', parentId: 'p', prevSiblingId: 'ghost' })
    const index = buildTreeIndex([p, x, y])

    // x is the chain head; y is appended in arrival order rather than lost
    expect(childrenOf(index, 'p').map((n) => n.id)).toEqual(['x', 'y'])
  })
})

describe('buildTreeIndex mirrorsBySource (ADR 0022)', () => {
  test('is empty for a mirror-free outline', () => {
    const a = makeNode({ id: 'a' })
    const b = makeNode({ id: 'b', prevSiblingId: 'a' })
    const index = buildTreeIndex([a, b])
    expect(index.mirrorsBySource.size).toBe(0)
  })

  test('buckets every mirror under its source id', () => {
    const src = makeNode({ id: 'src' })
    const m1 = makeNode({ id: 'm1', mirrorOf: 'src' })
    const m2 = makeNode({ id: 'm2', mirrorOf: 'src' })
    const other = makeNode({ id: 'other' })
    const index = buildTreeIndex([src, m1, m2, other])

    expect(index.mirrorsBySource.get('src')).toEqual(['m1', 'm2'])
    // A source is not its own mirror; an un-mirrored node has no bucket.
    expect(index.mirrorsBySource.has('other')).toBe(false)
    expect(index.mirrorsBySource.has('m1')).toBe(false)
  })

  test('a mirror whose source is absent still indexes (broken-mirror tolerant)', () => {
    const m = makeNode({ id: 'm', mirrorOf: 'ghost' })
    const index = buildTreeIndex([m])
    expect(index.mirrorsBySource.get('ghost')).toEqual(['m'])
  })
})

describe('buildTrail', () => {
  // a -> b -> c (parent chain)
  const a = makeNode({ id: 'a', parentId: null })
  const b = makeNode({ id: 'b', parentId: 'a' })
  const c = makeNode({ id: 'c', parentId: 'b' })
  const index = buildTreeIndex([a, b, c])

  test('walks ancestors top-down, including rootId itself', () => {
    expect(buildTrail(index, 'c').map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(buildTrail(index, 'a').map((n) => n.id)).toEqual(['a'])
  })

  test('null root yields an empty trail', () => {
    expect(buildTrail(index, null)).toEqual([])
  })
})
