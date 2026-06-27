import type { Node } from './schema'

/**
 * The sibling chain. Within a parent, children form a singly linked list via
 * `prevSiblingId`: exactly one head (`prevSiblingId === null`), every other node
 * points at its predecessor, and following the chain reaches each child once.
 * This module owns the READ side of that invariant — deriving canonical order
 * from the chain (`orderSiblings`) and finding where stored pointers disagree
 * with it (`chainDisagreements`). Three callers share these two functions:
 * `buildTreeIndex` (order), `siblingChainRepairs` (repair = apply every
 * disagreement), and the structural dev tripwire (validate = report the first).
 *
 * Pure over `Node[]` — no collection, no DOM. The WRITE side (relinking the
 * chain on insert/move/remove) still lives in `mutations.ts`. Why the invariant
 * matters and how it can break (a fan, a dangle): ADR 0009.
 */

/**
 * Order one parent's children by following the `prevSiblingId` chain from the
 * head. Nodes orphaned by a broken pointer (a fan — two siblings sharing one
 * prev; a dangle — a pointer to a missing/foreign id) are appended in arrival
 * order rather than dropped: a visible, movable bullet beats a vanished one.
 * The iteration cap makes a cyclic chain terminate. Pass the children of a
 * single parent; a list of 0 or 1 is returned unchanged.
 */
export function orderSiblings(unordered: Node[]): Node[] {
  if (unordered.length <= 1) return unordered

  const byPrev = new Map<string | null, Node>()
  for (const n of unordered) byPrev.set(n.prevSiblingId, n)

  const ordered: Node[] = []
  const idsInChain = new Set<string>()
  let cursor: string | null = null
  // Guard against cycles / corruption with an iteration cap.
  let guard = unordered.length + 1
  while (guard-- > 0) {
    const next = byPrev.get(cursor)
    if (!next) break
    ordered.push(next)
    idsInChain.add(next.id)
    cursor = next.id
  }

  for (const n of unordered) {
    if (!idsInChain.has(n.id)) ordered.push(n)
  }

  return ordered
}

/** One node whose stored `prevSiblingId` disagrees with its canonical position:
 *  `expectedPrev` is the node it should point at, `actualPrev` what it stores. */
export interface ChainDisagreement {
  id: string
  expectedPrev: string | null
  actualPrev: string | null
}

/**
 * Given a parent's children in canonical order, return every node whose stored
 * `prevSiblingId` disagrees with its position — each node should point at the
 * one before it, the head at null. The repair path applies these as fixes; the
 * validate path treats the first as a broken-invariant tripwire.
 */
export function chainDisagreements(ordered: Node[]): ChainDisagreement[] {
  const out: ChainDisagreement[] = []
  let prev: string | null = null
  for (const child of ordered) {
    const actualPrev = child.prevSiblingId ?? null
    if (actualPrev !== prev) {
      out.push({ id: child.id, expectedPrev: prev, actualPrev })
    }
    prev = child.id
  }
  return out
}
