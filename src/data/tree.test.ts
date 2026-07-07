import { describe, expect, test } from 'bun:test'
import {
  buildTrail,
  buildTreeIndex,
  childrenOf,
  countSubtreeNodes,
  makeNode,
  orphanedMirrorsBy,
  planRemoveSubtrees,
  trueSourceOf,
  wouldMirrorCycle,
} from './tree'

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

describe('orphanedMirrorsBy (delete-source guard, ADR 0022)', () => {
  // src has two children; M (under p) mirrors src.
  const tree = () => [
    makeNode({ id: 'src' }),
    makeNode({ id: 'k1', parentId: 'src', prevSiblingId: null }),
    makeNode({ id: 'k2', parentId: 'src', prevSiblingId: 'k1' }),
    makeNode({ id: 'p', prevSiblingId: 'src' }),
    makeNode({ id: 'M', parentId: 'p', prevSiblingId: null, mirrorOf: 'src' }),
  ]

  test('deleting a source with a live mirror reports the orphan', () => {
    const index = buildTreeIndex(tree())
    expect(orphanedMirrorsBy(index, ['src'])).toEqual(['M'])
  })

  test('deleting a plain mirror is always safe', () => {
    const index = buildTreeIndex(tree())
    expect(orphanedMirrorsBy(index, ['M'])).toEqual([])
  })

  test('a source is found even when it sits inside the deleted subtree', () => {
    // Delete p's parent; src is a deep descendant whose mirror lives elsewhere.
    const nested = [
      makeNode({ id: 'top' }),
      makeNode({ id: 'src', parentId: 'top', prevSiblingId: null }),
      makeNode({ id: 'p', prevSiblingId: 'top' }),
      makeNode({ id: 'M', parentId: 'p', prevSiblingId: null, mirrorOf: 'src' }),
    ]
    const index = buildTreeIndex(nested)
    expect(orphanedMirrorsBy(index, ['top'])).toEqual(['M'])
  })

  test('deleting a source together with all its mirrors is safe', () => {
    // Both src and its only mirror M sit under `top`, so deleting top takes both.
    const together = [
      makeNode({ id: 'top' }),
      makeNode({ id: 'src', parentId: 'top', prevSiblingId: null }),
      makeNode({ id: 'M', parentId: 'top', prevSiblingId: 'src', mirrorOf: 'src' }),
    ]
    const index = buildTreeIndex(together)
    expect(orphanedMirrorsBy(index, ['top'])).toEqual([])
  })

  test('a mirror-free deletion is always safe', () => {
    const index = buildTreeIndex([
      makeNode({ id: 'a' }),
      makeNode({ id: 'b', parentId: 'a', prevSiblingId: null }),
    ])
    expect(orphanedMirrorsBy(index, ['a'])).toEqual([])
  })
})

describe('trueSourceOf (mirror flatten, ADR 0022)', () => {
  const src = makeNode({ id: 'src' })
  const m = makeNode({ id: 'm', mirrorOf: 'src' })
  const plain = makeNode({ id: 'plain' })
  const index = buildTreeIndex([src, m, plain])

  test('a non-mirror node is its own source', () => {
    expect(trueSourceOf(index, 'plain')).toBe('plain')
    expect(trueSourceOf(index, 'src')).toBe('src')
  })

  test('a mirror resolves to its source (one hop -- the create invariant)', () => {
    // mirrorOf always points at a TRUE source, so mirroring a mirror flattens to
    // that same source rather than chaining through the mirror.
    expect(trueSourceOf(index, 'm')).toBe('src')
  })

  test('an unknown id resolves to itself (tolerant)', () => {
    expect(trueSourceOf(index, 'ghost')).toBe('ghost')
  })
})

describe('wouldMirrorCycle (ADR 0022)', () => {
  // src > c > gc ; `other` is an unrelated top-level node.
  const src = makeNode({ id: 'src', parentId: null })
  const c = makeNode({ id: 'c', parentId: 'src' })
  const gc = makeNode({ id: 'gc', parentId: 'c' })
  const other = makeNode({ id: 'other', parentId: null, prevSiblingId: 'src' })
  const index = buildTreeIndex([src, c, gc, other])

  test('mirroring into an unrelated branch is fine', () => {
    expect(wouldMirrorCycle(index, 'src', 'other')).toBe(false)
  })

  test('mirroring into the source itself cycles', () => {
    expect(wouldMirrorCycle(index, 'src', 'src')).toBe(true)
  })

  test('mirroring into a descendant of the source cycles (direct + deep)', () => {
    expect(wouldMirrorCycle(index, 'src', 'c')).toBe(true)
    expect(wouldMirrorCycle(index, 'src', 'gc')).toBe(true)
  })

  test('mirroring a descendant under the source does NOT cycle', () => {
    // A mirror of `c` placed under `src` windows c's subtree, which never
    // contains the mirror -- only `src` being an ancestor would close a loop.
    expect(wouldMirrorCycle(index, 'c', 'src')).toBe(false)
  })

  test('Home (null parent) never cycles', () => {
    expect(wouldMirrorCycle(index, 'src', null)).toBe(false)
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

describe('countSubtreeNodes + planRemoveSubtrees', () => {
  // top-level: x -> p -> y ; p's children a -> b -> c ; b's children b1 -> b2
  const fixture = () =>
    buildTreeIndex([
      makeNode({ id: 'x', prevSiblingId: null }),
      makeNode({ id: 'p', prevSiblingId: 'x' }),
      makeNode({ id: 'y', prevSiblingId: 'p' }),
      makeNode({ id: 'a', parentId: 'p', prevSiblingId: null }),
      makeNode({ id: 'b', parentId: 'p', prevSiblingId: 'a' }),
      makeNode({ id: 'c', parentId: 'p', prevSiblingId: 'b' }),
      makeNode({ id: 'b1', parentId: 'b', prevSiblingId: null }),
      makeNode({ id: 'b2', parentId: 'b', prevSiblingId: 'b1' }),
    ])

  test('counts roots + all descendants, deduping overlapping roots', () => {
    const index = fixture()
    expect(countSubtreeNodes(index, ['p'])).toBe(6)
    expect(countSubtreeNodes(index, ['b'])).toBe(3)
    // b sits inside p's subtree -- counted once
    expect(countSubtreeNodes(index, ['p', 'b'])).toBe(6)
    expect(countSubtreeNodes(index, ['ghost'])).toBe(0)
  })

  test('single root: deletes children-before-parent, repoints the follower', () => {
    const index = fixture()
    const plan = planRemoveSubtrees(index, ['p'])
    expect(plan.deleteIds).toHaveLength(6)
    // reverse pre-order: the root is deleted LAST, every child before its parent
    expect(plan.deleteIds[plan.deleteIds.length - 1]).toBe('p')
    expect(plan.deleteIds.indexOf('b1')).toBeLessThan(plan.deleteIds.indexOf('b'))
    expect(plan.deleteIds.indexOf('b2')).toBeLessThan(plan.deleteIds.indexOf('b'))
    // y followed p -> repointed to p's prev (x)
    expect(plan.repoints).toEqual([{ id: 'y', prevSiblingId: 'x' }])
  })

  test('contiguous run: the survivor walks the whole doomed chain to its head', () => {
    const index = fixture()
    const plan = planRemoveSubtrees(index, ['a', 'b'])
    expect(plan.deleteIds).toHaveLength(4)
    // c followed b; a and b are both doomed -> c becomes the head (null prev)
    expect(plan.repoints).toEqual([{ id: 'c', prevSiblingId: null }])
  })

  test('tail root needs no repoint; unknown ids are skipped', () => {
    const index = fixture()
    const plan = planRemoveSubtrees(index, ['y', 'ghost'])
    expect(plan.deleteIds).toEqual(['y'])
    expect(plan.repoints).toEqual([])
  })
})
