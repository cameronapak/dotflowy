import { describe, expect, test } from 'bun:test'
import { buildTreeIndex, makeNode } from './tree'
import { buildVisibleRows } from './visible-order'

const show = () => false // nothing hidden
const hideCompleted = (n: { completed: boolean }) => n.completed

describe('buildVisibleRows — mirror-free parity (the default path)', () => {
  // A
  //   a1
  //   a2
  // B
  const tree = [
    makeNode({ id: 'A', prevSiblingId: null }),
    makeNode({ id: 'B', prevSiblingId: 'A' }),
    makeNode({ id: 'a1', parentId: 'A', prevSiblingId: null }),
    makeNode({ id: 'a2', parentId: 'A', prevSiblingId: 'a1' }),
  ]
  const index = buildTreeIndex(tree)

  test('every row is its own content, keyed by bare id, never a mirror', () => {
    const rows = buildVisibleRows(index, null, show)
    expect(rows.map((r) => r.id)).toEqual(['A', 'a1', 'a2', 'B'])
    for (const r of rows) {
      expect(r.contentId).toBe(r.id)
      expect(r.key).toBe(r.id)
      expect(r.isMirror).toBe(false)
      expect(r.capped).toBe(false)
      expect(r.broken).toBe(false)
    }
  })

  test('depth + fade inheritance unchanged', () => {
    const rows = buildVisibleRows(index, null, show)
    expect(rows.find((r) => r.id === 'a1')?.depth).toBe(1)
    expect(rows.find((r) => r.id === 'A')?.depth).toBe(0)
  })

  test('a node carrying mirrorOf is treated as normal while the flag is OFF', () => {
    // Same node set, but B mirrors A. With mirrors disabled (default arg) B is an
    // ordinary leaf — no source windowing, no resolution. Byte-identical to today.
    const withMirror = [
      makeNode({ id: 'A', prevSiblingId: null }),
      makeNode({ id: 'B', prevSiblingId: 'A', mirrorOf: 'A' }),
      makeNode({ id: 'a1', parentId: 'A', prevSiblingId: null }),
    ]
    const i2 = buildTreeIndex(withMirror)
    const rows = buildVisibleRows(i2, null, show) // mirrorsEnabled defaults false
    const b = rows.find((r) => r.id === 'B')!
    expect(b.contentId).toBe('B')
    expect(b.isMirror).toBe(false)
    // B's "children" are not A's — A's children don't appear under B.
    expect(rows.map((r) => r.id)).toEqual(['A', 'a1', 'B'])
  })
})

describe('buildVisibleRows — mirrors enabled (ADR 0022)', () => {
  // A          (source)
  //   a1
  //   a2
  // P
  //   M -> A   (a mirror of A, windowing a1/a2)
  const tree = [
    makeNode({ id: 'A', prevSiblingId: null }),
    makeNode({ id: 'P', prevSiblingId: 'A' }),
    makeNode({ id: 'a1', parentId: 'A', prevSiblingId: null }),
    makeNode({ id: 'a2', parentId: 'A', prevSiblingId: 'a1' }),
    makeNode({ id: 'M', parentId: 'P', prevSiblingId: null, mirrorOf: 'A' }),
  ]
  const index = buildTreeIndex(tree)

  test("a mirror windows the source's children", () => {
    const rows = buildVisibleRows(index, null, show, null, true)
    expect(rows.map((r) => r.id)).toEqual(['A', 'a1', 'a2', 'P', 'M', 'a1', 'a2'])

    const m = rows.find((r) => r.id === 'M')!
    expect(m.isMirror).toBe(true)
    expect(m.contentId).toBe('A') // reads the source's content
    expect(m.key).toBe('M') // top-level mirror: bare id (no mirror crossed yet)
    expect(m.capped).toBe(false)
    expect(m.broken).toBe(false)
  })

  test('source descendants get unique path keys under the mirror, bare ids under the source', () => {
    const rows = buildVisibleRows(index, null, show, null, true)
    // Two rows share id 'a1' (real + mirrored) but their keys are distinct.
    const a1Rows = rows.filter((r) => r.id === 'a1')
    expect(a1Rows).toHaveLength(2)
    const keys = a1Rows.map((r) => r.key)
    expect(keys[0]).toBe('a1') // under the real source: bare id (today's identity)
    expect(keys[1]).not.toBe('a1') // under the mirror: a compound path key
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length) // all keys unique
    // The mirrored copies still read their own (real) content.
    for (const r of a1Rows) expect(r.contentId).toBe('a1')
  })

  test('two mirrors of the same source keep distinct keys', () => {
    // P holds two mirrors of A back to back.
    const t2 = [
      makeNode({ id: 'A', prevSiblingId: null }),
      makeNode({ id: 'P', prevSiblingId: 'A' }),
      makeNode({ id: 'a1', parentId: 'A', prevSiblingId: null }),
      makeNode({ id: 'M1', parentId: 'P', prevSiblingId: null, mirrorOf: 'A' }),
      makeNode({ id: 'M2', parentId: 'P', prevSiblingId: 'M1', mirrorOf: 'A' }),
    ]
    const rows = buildVisibleRows(buildTreeIndex(t2), null, show, null, true)
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  test('collapse is LOCAL to the instance — a collapsed mirror hides the source subtree', () => {
    const t2 = [
      makeNode({ id: 'A', prevSiblingId: null }),
      makeNode({ id: 'P', prevSiblingId: 'A' }),
      makeNode({ id: 'a1', parentId: 'A', prevSiblingId: null }),
      // The mirror itself is collapsed; the source A is NOT.
      makeNode({ id: 'M', parentId: 'P', prevSiblingId: null, mirrorOf: 'A', collapsed: true }),
    ]
    const rows = buildVisibleRows(buildTreeIndex(t2), null, show, null, true)
    // a1 appears once (under the real, expanded A) — not under the collapsed mirror.
    expect(rows.filter((r) => r.id === 'a1')).toHaveLength(1)
    expect(rows.map((r) => r.id)).toEqual(['A', 'a1', 'P', 'M'])
  })

  test("visibility prunes follow the SOURCE's completed (content), not the instance", () => {
    // Source A is completed; the mirror node M itself is not.
    const t2 = [
      makeNode({ id: 'A', prevSiblingId: null, completed: true }),
      makeNode({ id: 'P', prevSiblingId: 'A' }),
      makeNode({ id: 'M', parentId: 'P', prevSiblingId: null, mirrorOf: 'A', completed: false }),
    ]
    const rows = buildVisibleRows(buildTreeIndex(t2), null, hideCompleted, null, true)
    // Hide-completed reads the resolved content (A is completed), so the mirror is
    // pruned — checking the source off hides every instance.
    expect(rows.some((r) => r.id === 'M')).toBe(false)
    expect(rows.some((r) => r.id === 'A')).toBe(false)
  })
})

describe('buildVisibleRows — cycle + broken guards', () => {
  test('a mirror whose source is an ancestor caps instead of looping', () => {
    // A contains a mirror of A — an immediate cycle.
    const t = [
      makeNode({ id: 'A', prevSiblingId: null }),
      makeNode({ id: 'M', parentId: 'A', prevSiblingId: null, mirrorOf: 'A' }),
    ]
    const rows = buildVisibleRows(buildTreeIndex(t), null, show, null, true)
    const m = rows.find((r) => r.id === 'M')!
    expect(m.isMirror).toBe(true)
    expect(m.capped).toBe(true)
    // Capped => not expanded: no second copy of M (or A) underneath it.
    expect(rows.map((r) => r.id)).toEqual(['A', 'M'])
  })

  test('a deep cycle (mirror of an ancestor several levels up) still caps', () => {
    // A > b > M(->A): M's source A is an expanded ancestor.
    const t = [
      makeNode({ id: 'A', prevSiblingId: null }),
      makeNode({ id: 'b', parentId: 'A', prevSiblingId: null }),
      makeNode({ id: 'M', parentId: 'b', prevSiblingId: null, mirrorOf: 'A' }),
    ]
    const rows = buildVisibleRows(buildTreeIndex(t), null, show, null, true)
    expect(rows.find((r) => r.id === 'M')?.capped).toBe(true)
    expect(rows.map((r) => r.id)).toEqual(['A', 'b', 'M'])
  })

  test('a mirror whose source is missing renders a broken leaf, never throws', () => {
    const t = [makeNode({ id: 'M', prevSiblingId: null, mirrorOf: 'ghost' })]
    const rows = buildVisibleRows(buildTreeIndex(t), null, show, null, true)
    const m = rows.find((r) => r.id === 'M')!
    expect(m.broken).toBe(true)
    expect(m.contentId).toBe('ghost')
    expect(rows).toHaveLength(1) // no children expanded
  })
})
