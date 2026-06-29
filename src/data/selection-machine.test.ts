import { describe, expect, test } from 'bun:test'
import { createActor } from 'xstate'
import { selectionMachine, type SelectionContext } from './selection-machine'

/**
 * Pure-logic unit tests for the PoC selection machine (the repo's "pure logic
 * only" tier — no DOM, no collection). Driving `createActor` proves the XState v6
 * machine AND the Effect-Schema-derived types work at runtime, mirroring the
 * `selection-state.ts` semantics from ADR 0018.
 */

const SIBS = ['a', 'b', 'c'] as const

describe('selectionMachine', () => {
  test('starts idle with empty context', () => {
    const actor = createActor(selectionMachine).start()
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.rootIds).toEqual([])
    expect(snap.context.anchorId).toBeNull()
  })

  test('SELECT_SINGLE enters `single` on exactly that node', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_SINGLE', nodeId: 'b', parentId: null, siblings: [...SIBS] })
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('single')
    expect(snap.context.anchorId).toBe('b')
    expect(snap.context.focusId).toBe('b')
    expect(snap.context.rootIds).toEqual(['b'])
  })

  test('EXTEND down grows the run and flips to `multi`', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_SINGLE', nodeId: 'b', parentId: null, siblings: [...SIBS] })
    actor.send({ type: 'EXTEND', dir: 'down', siblings: [...SIBS] })
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('multi')
    expect(snap.context.rootIds).toEqual(['b', 'c'])
    expect(snap.context.focusId).toBe('c')
    expect(snap.context.anchorId).toBe('b') // anchor stays fixed
  })

  test('reversing direction shrinks back toward the anchor (anchor/focus model)', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_SINGLE', nodeId: 'b', parentId: null, siblings: [...SIBS] })
    actor.send({ type: 'EXTEND', dir: 'down', siblings: [...SIBS] }) // [b,c]
    actor.send({ type: 'EXTEND', dir: 'up', siblings: [...SIBS] }) //   back to [b]
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('single')
    expect(snap.context.rootIds).toEqual(['b'])
  })

  test('EXTEND at the sibling boundary is a no-op (depth-walk lives in the adapter)', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_SINGLE', nodeId: 'c', parentId: null, siblings: [...SIBS] })
    actor.send({ type: 'EXTEND', dir: 'down', siblings: [...SIBS] }) // c is last -> no-op
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('single')
    expect(snap.context.rootIds).toEqual(['c'])
  })

  test('SELECT_ALL selects the whole visible run', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_ALL', parentId: null, siblings: [...SIBS] })
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('multi')
    expect(snap.context.rootIds).toEqual(['a', 'b', 'c'])
    expect(snap.context.anchorId).toBe('a')
    expect(snap.context.focusId).toBe('c')
  })

  test('CLEAR returns to idle and resets context', () => {
    const actor = createActor(selectionMachine).start()
    actor.send({ type: 'SELECT_SINGLE', nodeId: 'b', parentId: null, siblings: [...SIBS] })
    actor.send({ type: 'CLEAR' })
    const snap = actor.getSnapshot()
    expect(snap.value).toBe('idle')
    expect(snap.context.rootIds).toEqual([])
    expect(snap.context.focusId).toBeNull()
  })

  test('the v6 `actor.trigger` proxy sends typed events', () => {
    const actor = createActor(selectionMachine).start()
    actor.trigger.SELECT_SINGLE({ nodeId: 'a', parentId: null, siblings: [...SIBS] })
    expect(actor.getSnapshot().context.rootIds).toEqual(['a'])
  })

  test('context type is the Effect-Schema-derived shape (compile-time check)', () => {
    const actor = createActor(selectionMachine).start()
    // Assigning the snapshot context to the exported Effect-derived type compiles
    // only because XState inferred the machine context from the Effect schema.
    const ctx: SelectionContext = actor.getSnapshot().context
    expect(ctx.rootIds).toEqual([])
  })
})
