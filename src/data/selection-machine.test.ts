import { describe, expect, test } from 'bun:test'
import { createActor } from 'xstate'
import {
  buildEdgeMap,
  rangeFrom,
  selectionMachine,
  type SelectionContext,
} from './selection-machine'

/**
 * Pure-logic unit tests (the repo's "pure logic only" tier -- no DOM, no
 * collection). Driving `createActor` proves the XState v6 machine AND the
 * Effect-Schema-derived types work at runtime; the `rangeFrom`/`buildEdgeMap`
 * tests cover the math both the machine and the singleton backend share. The
 * full keyboard/menu behavior is the e2e tier (`node-multi-select*.spec.ts`).
 */

const SIBS = ['a', 'b', 'c'] as const

describe('selectionMachine', () => {
  test('starts idle with empty context', () => {
    const snap = createActor(selectionMachine).start().getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.rootIds).toEqual([])
    expect(snap.context.anchorId).toBeNull()
  })

  test('SELECT_RANGE of one node enters `single`', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_RANGE', parentId: null, anchorId: 'b', focusId: 'b', siblings: [...SIBS] })
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('single')
    expect(snap.context.anchorId).toBe('b')
    expect(snap.context.rootIds).toEqual(['b'])
  })

  test('SELECT_RANGE across siblings enters `multi`, focus is the moving end', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_RANGE', parentId: null, anchorId: 'a', focusId: 'c', siblings: [...SIBS] })
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('multi')
    expect(snap.context.rootIds).toEqual(['a', 'b', 'c'])
    expect(snap.context.anchorId).toBe('a')
    expect(snap.context.focusId).toBe('c')
  })

  test('a focus that is not a visible sibling collapses to the anchor', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_RANGE', parentId: null, anchorId: 'b', focusId: 'zzz', siblings: [...SIBS] })
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('single')
    expect(snap.context.rootIds).toEqual(['b'])
  })

  test('SELECT_RANGE whose anchor is gone clears to idle', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_RANGE', parentId: null, anchorId: 'a', focusId: 'c', siblings: [...SIBS] })
    actor.send({ type: 'SELECT_RANGE', parentId: null, anchorId: 'gone', focusId: 'gone', siblings: [...SIBS] })
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.rootIds).toEqual([])
  })

  test('CLEAR returns to idle and resets context', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_RANGE', parentId: null, anchorId: 'b', focusId: 'b', siblings: [...SIBS] })
    actor.send({ type: 'CLEAR' })
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.focusId).toBeNull()
  })

  test('the v6 `actor.trigger` proxy sends typed events', () => {
    const actor = createActor(selectionMachine).start()
    actor.trigger.SELECT_RANGE({ parentId: null, anchorId: 'a', focusId: 'a', siblings: [...SIBS] })
    expect(actor.getSnapshot().context.rootIds).toEqual(['a'])
  })

  test('context type is the Effect-Schema-derived shape (compile-time check)', () => {
    const actor = createActor(selectionMachine).start()
    // Compiles only because XState inferred the context from the Effect schema.
    const ctx: SelectionContext = actor.getSnapshot().context
    expect(ctx.rootIds).toEqual([])
  })
})

describe('rangeFrom', () => {
  test('returns the inclusive run between anchor and focus', () => {
    expect(rangeFrom(SIBS, 'a', 'c')).toEqual({ focusId: 'c', rootIds: ['a', 'b', 'c'] })
  })
  test('orders low..high regardless of anchor/focus direction', () => {
    expect(rangeFrom(SIBS, 'c', 'a')).toEqual({ focusId: 'a', rootIds: ['a', 'b', 'c'] })
  })
  test('collapses to the anchor when focus is missing', () => {
    expect(rangeFrom(SIBS, 'b', 'zzz')).toEqual({ focusId: 'b', rootIds: ['b'] })
  })
  test('returns null when the anchor is missing', () => {
    expect(rangeFrom(SIBS, 'zzz', 'a')).toBeNull()
  })
})

describe('buildEdgeMap', () => {
  test('a single root rounds all corners', () => {
    expect(buildEdgeMap(['x'])).toEqual(new Map([['x', 'single']]))
  })
  test('first/last are top/bottom, middles are middle', () => {
    expect(buildEdgeMap(['a', 'b', 'c', 'd'])).toEqual(
      new Map([
        ['a', 'top'],
        ['b', 'middle'],
        ['c', 'middle'],
        ['d', 'bottom'],
      ]),
    )
  })
  test('an empty run has no edges', () => {
    expect(buildEdgeMap([])).toEqual(new Map())
  })
})
