/**
 * The server-side outline planners (worker/outline-ops.ts): pure snapshot ->
 * ChangeOp-batch logic, the Worker twin of the client's mutations. Unit-tested
 * here because the chain surgery (insert repoints, cascade delete relinks,
 * mirror flatten/cycle rules, daily materialization) is exactly the kind of
 * pure logic bun test owns — e2e can't reach it (the MCP endpoint has no
 * browser caller). Fixtures use `makeNode()` (tree.ts), the canonical builder.
 */

import { describe, expect, test } from 'bun:test'
import { makeNode } from '../src/data/tree'
import type { ChangeOp, Node } from '../src/data/wire-schema'
import {
  DAILY_CONTAINER_TEXT,
  MirrorCycle,
  NodeNotFound,
  WouldOrphanMirrors,
  buildTreeIndex,
  flattenSubtree,
  formatDayText,
  formatOutlineLines,
  planAddNode,
  planAddToDaily,
  planDeleteNode,
  planEnsureDaily,
  planMirrorNode,
  planMirrorToDaily,
  planUpdateNode,
  searchNodes,
} from './outline-ops'

const T = 1_700_000_000_000

/** a -> b (top level), with a1 -> a2 under a. */
function fixture(): Node[] {
  return [
    makeNode({ id: 'a', text: 'alpha' }),
    makeNode({ id: 'b', text: 'bravo', prevSiblingId: 'a' }),
    makeNode({ id: 'a1', text: 'alpha one', parentId: 'a' }),
    makeNode({ id: 'a2', text: 'alpha two', parentId: 'a', prevSiblingId: 'a1' }),
  ]
}

function index(nodes: Node[]) {
  return buildTreeIndex(nodes)
}

function inserted(ops: ChangeOp[]): Node[] {
  return ops.flatMap((op) => (op.op === 'insert' ? [op.value] : []))
}

function updated(ops: ChangeOp[]): Node[] {
  return ops.flatMap((op) => (op.op === 'update' ? [op.value] : []))
}

function deletedKeys(ops: ChangeOp[]): string[] {
  return ops.flatMap((op) => (op.op === 'delete' ? [op.key] : []))
}

describe('planAddNode', () => {
  test('appends as the last child without repointing anyone', () => {
    const plan = planAddNode(index(fixture()), {
      id: 'new',
      text: 'x',
      parentId: 'a',
      position: 'last',
      isTask: false,
      timestamp: T,
    })
    if (plan instanceof Error) throw plan
    expect(plan.ops).toHaveLength(1)
    const node = inserted(plan.ops)[0]!
    expect(node.parentId).toBe('a')
    expect(node.prevSiblingId).toBe('a2')
  })

  test('inserting first repoints the old head', () => {
    const plan = planAddNode(index(fixture()), {
      id: 'new',
      text: 'x',
      parentId: 'a',
      position: 'first',
      isTask: true,
      timestamp: T,
    })
    if (plan instanceof Error) throw plan
    const node = inserted(plan.ops)[0]!
    expect(node.prevSiblingId).toBeNull()
    expect(node.isTask).toBe(true)
    const repointed = updated(plan.ops)[0]!
    expect(repointed.id).toBe('a1')
    expect(repointed.prevSiblingId).toBe('new')
  })

  test('null parent adds at the top level after the last root', () => {
    const plan = planAddNode(index(fixture()), {
      id: 'new',
      text: 'x',
      parentId: null,
      position: 'last',
      isTask: false,
      timestamp: T,
    })
    if (plan instanceof Error) throw plan
    const node = inserted(plan.ops)[0]!
    expect(node.parentId).toBeNull()
    expect(node.prevSiblingId).toBe('b')
  })

  test('a mirror parent redirects to its true source', () => {
    const nodes = [...fixture(), makeNode({ id: 'm', text: 'alpha', mirrorOf: 'a', prevSiblingId: 'b' })]
    const plan = planAddNode(index(nodes), {
      id: 'new',
      text: 'x',
      parentId: 'm',
      position: 'last',
      isTask: false,
      timestamp: T,
    })
    if (plan instanceof Error) throw plan
    expect(inserted(plan.ops)[0]!.parentId).toBe('a')
  })

  test('missing parent is NodeNotFound', () => {
    const plan = planAddNode(index(fixture()), {
      id: 'new',
      text: 'x',
      parentId: 'ghost',
      position: 'last',
      isTask: false,
      timestamp: T,
    })
    expect(plan).toBeInstanceOf(NodeNotFound)
  })
})

describe('planUpdateNode', () => {
  test('merges field changes into one update op', () => {
    const plan = planUpdateNode(index(fixture()), {
      nodeId: 'a1',
      changes: { text: 'renamed', completed: true },
      timestamp: T,
    })
    if (plan instanceof Error) throw plan
    expect(plan.ops).toHaveLength(1)
    const node = updated(plan.ops)[0]!
    expect(node.text).toBe('renamed')
    expect(node.completed).toBe(true)
    expect(node.updatedAt).toBe(T)
  })

  test('content fields on a mirror land on the source; collapsed stays local', () => {
    const nodes = [...fixture(), makeNode({ id: 'm', text: 'alpha', mirrorOf: 'a', prevSiblingId: 'b' })]
    const plan = planUpdateNode(index(nodes), {
      nodeId: 'm',
      changes: { text: 'shared edit', collapsed: true },
      timestamp: T,
    })
    if (plan instanceof Error) throw plan
    const byId = new Map(updated(plan.ops).map((n) => [n.id, n]))
    expect(byId.get('a')?.text).toBe('shared edit')
    expect(byId.get('m')?.collapsed).toBe(true)
    // The mirror's own text is untouched (display snapshot; reads resolve live).
    expect(byId.get('m')?.text).toBe('alpha')
  })

  test('missing node is NodeNotFound', () => {
    const plan = planUpdateNode(index(fixture()), {
      nodeId: 'ghost',
      changes: { text: 'x' },
      timestamp: T,
    })
    expect(plan).toBeInstanceOf(NodeNotFound)
  })
})

describe('planDeleteNode', () => {
  test('cascades the subtree and repoints the follower sibling', () => {
    const plan = planDeleteNode(index(fixture()), 'a', T)
    if (plan instanceof Error) throw plan
    expect(new Set(deletedKeys(plan.ops))).toEqual(new Set(['a', 'a1', 'a2']))
    const repointed = updated(plan.ops)[0]!
    expect(repointed.id).toBe('b')
    expect(repointed.prevSiblingId).toBeNull()
  })

  test('refuses when the subtree has surviving mirrors elsewhere', () => {
    const nodes = [...fixture(), makeNode({ id: 'm', text: 'alpha one', mirrorOf: 'a1', prevSiblingId: 'b' })]
    const plan = planDeleteNode(index(nodes), 'a', T)
    expect(plan).toBeInstanceOf(WouldOrphanMirrors)
  })

  test('deleting a mirror itself is safe and touches only the mirror', () => {
    const nodes = [...fixture(), makeNode({ id: 'm', text: 'alpha', mirrorOf: 'a', prevSiblingId: 'b' })]
    const plan = planDeleteNode(index(nodes), 'm', T)
    if (plan instanceof Error) throw plan
    expect(deletedKeys(plan.ops)).toEqual(['m'])
  })
})

describe('planMirrorNode', () => {
  test('mirrors as the last child, flattening mirror-of-mirror to the true source', () => {
    const nodes = [...fixture(), makeNode({ id: 'm', text: 'alpha one', mirrorOf: 'a1', prevSiblingId: 'b' })]
    const plan = planMirrorNode(index(nodes), {
      sourceId: 'm',
      targetParentId: 'b',
      id: 'mm',
      timestamp: T,
    })
    if (plan instanceof Error) throw plan
    const node = inserted(plan.ops)[0]!
    expect(node.mirrorOf).toBe('a1')
    expect(node.parentId).toBe('b')
    expect(plan.sourceId).toBe('a1')
  })

  test('refuses to mirror a node into its own subtree', () => {
    const plan = planMirrorNode(index(fixture()), {
      sourceId: 'a',
      targetParentId: 'a1',
      id: 'mm',
      timestamp: T,
    })
    expect(plan).toBeInstanceOf(MirrorCycle)
  })
})

describe('daily planning', () => {
  test('materializes both container and day on first use', () => {
    const plan = planEnsureDaily(index(fixture()), {
      dateKey: '2026-07-03',
      containerId: 'cont',
      dayId: 'day',
      timestamp: T,
    })
    const nodes = inserted(plan.ops)
    expect(nodes.map((n) => n.id)).toEqual(['cont', 'day'])
    const [container, day] = nodes as [Node, Node]
    expect(container.parentId).toBeNull()
    expect(container.prevSiblingId).toBe('b')
    expect(container.text).toBe(DAILY_CONTAINER_TEXT)
    expect(day.parentId).toBe('cont')
    expect(day.prevSiblingId).toBeNull()
    expect(day.text).toBe('Friday, July 3, 2026')
  })

  test('a new day goes on TOP of an existing container, pushing the old head down', () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: 'cont', text: DAILY_CONTAINER_TEXT, prevSiblingId: 'b' }),
      makeNode({ id: 'old-day', text: 'Thursday, July 2, 2026', parentId: 'cont' }),
    ]
    const plan = planEnsureDaily(index(nodes), {
      dateKey: '2026-07-03',
      containerId: 'cont',
      dayId: 'day',
      timestamp: T,
    })
    expect(inserted(plan.ops).map((n) => n.id)).toEqual(['day'])
    const repointed = updated(plan.ops)[0]!
    expect(repointed.id).toBe('old-day')
    expect(repointed.prevSiblingId).toBe('day')
  })

  test('heals a blank existing day text and otherwise no-ops', () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: 'cont', text: DAILY_CONTAINER_TEXT, prevSiblingId: 'b' }),
      makeNode({ id: 'day', text: '  ', parentId: 'cont' }),
    ]
    const plan = planEnsureDaily(index(nodes), {
      dateKey: '2026-07-03',
      containerId: 'cont',
      dayId: 'day',
      timestamp: T,
    })
    expect(plan.ops).toHaveLength(1)
    expect(updated(plan.ops)[0]!.text).toBe('Friday, July 3, 2026')

    const healthy = nodes.map((n) => (n.id === 'day' ? { ...n, text: 'Friday, July 3, 2026' } : n))
    expect(
      planEnsureDaily(index(healthy), {
        dateKey: '2026-07-03',
        containerId: 'cont',
        dayId: 'day',
        timestamp: T,
      }).ops,
    ).toHaveLength(0)
  })

  test('planAddToDaily appends after an existing day\'s last child', () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: 'cont', text: DAILY_CONTAINER_TEXT, prevSiblingId: 'b' }),
      makeNode({ id: 'day', text: 'Friday, July 3, 2026', parentId: 'cont' }),
      makeNode({ id: 'entry1', text: 'existing', parentId: 'day' }),
    ]
    const plan = planAddToDaily(index(nodes), {
      dateKey: '2026-07-03',
      containerId: 'cont',
      dayId: 'day',
      newNodeId: 'entry2',
      text: 'captured',
      isTask: true,
      timestamp: T,
    })
    const node = inserted(plan.ops)[0]!
    expect(node.parentId).toBe('day')
    expect(node.prevSiblingId).toBe('entry1')
    expect(node.isTask).toBe(true)
  })

  test('planMirrorToDaily refuses mirroring the container onto its own day', () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: 'cont', text: DAILY_CONTAINER_TEXT, prevSiblingId: 'b' }),
      makeNode({ id: 'day', text: 'Friday, July 3, 2026', parentId: 'cont' }),
    ]
    const plan = planMirrorToDaily(index(nodes), {
      dateKey: '2026-07-03',
      containerId: 'cont',
      dayId: 'day',
      sourceId: 'cont',
      mirrorId: 'mm',
      timestamp: T,
    })
    expect(plan).toBeInstanceOf(MirrorCycle)
  })

  test('planMirrorToDaily refuses mirroring the container onto a not-yet-created day', () => {
    // Regression: a fresh day isn't in the snapshot, so walking up from its id
    // finds nothing — the guard must fall back to the container it will hang
    // under, or it builds a self-cycle (day under container, mirror->container
    // under day).
    const nodes = [
      ...fixture(),
      makeNode({ id: 'cont', text: DAILY_CONTAINER_TEXT, prevSiblingId: 'b' }),
    ]
    const plan = planMirrorToDaily(index(nodes), {
      dateKey: '2026-07-03',
      containerId: 'cont',
      dayId: 'day', // not present in the snapshot
      sourceId: 'cont',
      mirrorId: 'mm',
      timestamp: T,
    })
    expect(plan).toBeInstanceOf(MirrorCycle)
  })

  test('planMirrorToDaily mirrors an outside node onto the day', () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: 'cont', text: DAILY_CONTAINER_TEXT, prevSiblingId: 'b' }),
      makeNode({ id: 'day', text: 'Friday, July 3, 2026', parentId: 'cont' }),
    ]
    const plan = planMirrorToDaily(index(nodes), {
      dateKey: '2026-07-03',
      containerId: 'cont',
      dayId: 'day',
      sourceId: 'a1',
      mirrorId: 'mm',
      timestamp: T,
    })
    if (plan instanceof Error) throw plan
    const node = inserted(plan.ops)[0]!
    expect(node.mirrorOf).toBe('a1')
    expect(node.parentId).toBe('day')
  })

  test('formatDayText renders the seeded full date', () => {
    expect(formatDayText('2026-07-03')).toBe('Friday, July 3, 2026')
    expect(formatDayText('not-a-date')).toBe('not-a-date')
  })

  test('formatDayText returns the raw key for a shaped-but-impossible date', () => {
    // Date.UTC rolls these over ("2026-13-45" -> 2027-02-14); the round-trip
    // guard must reject them instead of seeding a date months off the key.
    expect(formatDayText('2026-13-45')).toBe('2026-13-45')
    expect(formatDayText('2026-02-31')).toBe('2026-02-31')
  })
})

describe('reads', () => {
  test('flattenSubtree windows a mirror\'s source children and caps cycles', () => {
    // m mirrors a; a contains m2, which mirrors a again -> the inner instance
    // must render capped instead of recursing forever.
    const nodes = [
      makeNode({ id: 'a', text: 'alpha' }),
      makeNode({ id: 'a1', text: 'kid', parentId: 'a' }),
      makeNode({ id: 'm2', text: 'alpha', parentId: 'a', prevSiblingId: 'a1', mirrorOf: 'a' }),
      makeNode({ id: 'm', text: 'alpha', prevSiblingId: 'a', mirrorOf: 'a' }),
    ]
    const result = flattenSubtree(index(nodes), 'm', { maxDepth: 99, maxNodes: 100 })
    if (result instanceof Error) throw result
    const byId = new Map(result.lines.map((l) => [l.id, l]))
    expect(byId.get('m')?.text).toBe('alpha')
    expect(byId.get('a1')?.depth).toBe(1)
    expect(byId.get('m2')?.capped).toBe(true)
    expect(result.lines).toHaveLength(3)
  })

  test('flattenSubtree truncates at maxNodes and reports it', () => {
    const result = flattenSubtree(index(fixture()), null, { maxDepth: 99, maxNodes: 2 })
    if (result instanceof Error) throw result
    expect(result.lines).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  test('formatOutlineLines renders indentation, checkboxes, and ids', () => {
    const nodes = [
      makeNode({ id: 'a', text: 'alpha' }),
      makeNode({ id: 'a1', text: 'todo', parentId: 'a', isTask: true, completed: true }),
    ]
    const result = flattenSubtree(index(nodes), null, { maxDepth: 99, maxNodes: 100 })
    if (result instanceof Error) throw result
    expect(formatOutlineLines(result.lines)).toBe('- alpha (id: a)\n  - [x] todo (id: a1)')
  })

  test('searchNodes matches case-insensitively with a breadcrumb path', () => {
    const hits = searchNodes(index(fixture()), 'ALPHA ONE', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toBe('a1')
    expect(hits[0]!.path).toEqual(['alpha'])
  })

  test('searchNodes caps at the limit', () => {
    expect(searchNodes(index(fixture()), 'alpha', 2)).toHaveLength(2)
  })
})
