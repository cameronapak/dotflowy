import type { Node } from "./schema";

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
 * prev; a dangle — a pointer to a missing/foreign id) are still kept — a
 * visible, movable bullet beats a vanished one.
 *
 * After the primary walk from `null`, remaining orphans are stitched by
 * following *their* `prevSiblingId` links as subchains (arrival order only as a
 * last resort). A fan that leaves a paste block off the winning head must not
 * scramble that block into collection order — that is what made Lunora
 * multi-paragraph paste look "scattered" after refresh on a corrupted
 * top-level chain.
 *
 * The iteration cap makes a cyclic chain terminate. Pass the children of a
 * single parent; a list of 0 or 1 is returned unchanged.
 */
export function orderSiblings(unordered: Node[]): Node[] {
  if (unordered.length <= 1) return unordered;

  // Multimap: fans keep every claimant (Map.set would drop all but the last).
  const byPrev = new Map<string | null, Node[]>();
  for (const n of unordered) {
    const key = n.prevSiblingId ?? null;
    const list = byPrev.get(key);
    if (list) list.push(n);
    else byPrev.set(key, [n]);
  }

  const ordered: Node[] = [];
  const seen = new Set<string>();

  const walkFrom = (startPrev: string | null): void => {
    let cursor: string | null = startPrev;
    let guard = unordered.length + 1;
    while (guard-- > 0) {
      const claimants = byPrev.get(cursor);
      if (!claimants) break;
      const next = claimants.find((n) => !seen.has(n.id));
      if (!next) break;
      ordered.push(next);
      seen.add(next.id);
      cursor = next.id;
    }
  };

  // Primary walk from the true head (null). On a fan of heads, arrival order
  // among null-prev claimants picks the winner — stable for a given input list.
  walkFrom(null);

  // Stitch orphan subchains: extend from the current tip when possible, else
  // start a local head (prev missing / already placed / not among remaining).
  let guard = unordered.length + 1;
  while (seen.size < unordered.length && guard-- > 0) {
    const before = ordered.length;
    const tip = ordered.length > 0 ? ordered[ordered.length - 1]!.id : null;
    if (tip !== null) walkFrom(tip);
    if (ordered.length > before) continue;

    const remaining = unordered.filter((n) => !seen.has(n.id));
    if (remaining.length === 0) break;
    const remainingIds = new Set(remaining.map((n) => n.id));
    const localHead =
      remaining.find((n) => {
        const prev = n.prevSiblingId;
        return prev == null || !remainingIds.has(prev);
      }) ?? remaining[0]!;

    if (localHead.prevSiblingId && seen.has(localHead.prevSiblingId)) {
      walkFrom(localHead.prevSiblingId);
      if (ordered.length > before) continue;
    }

    if (!seen.has(localHead.id)) {
      ordered.push(localHead);
      seen.add(localHead.id);
      walkFrom(localHead.id);
    }
  }

  for (const n of unordered) {
    if (!seen.has(n.id)) ordered.push(n);
  }

  return ordered;
}

/** One node whose stored `prevSiblingId` disagrees with its canonical position:
 *  `expectedPrev` is the node it should point at, `actualPrev` what it stores. */
export interface ChainDisagreement {
  id: string;
  expectedPrev: string | null;
  actualPrev: string | null;
}

/**
 * Given a parent's children in canonical order, return every node whose stored
 * `prevSiblingId` disagrees with its position — each node should point at the
 * one before it, the head at null. The repair path applies these as fixes; the
 * validate path treats the first as a broken-invariant tripwire.
 */
export function chainDisagreements(ordered: Node[]): ChainDisagreement[] {
  const out: ChainDisagreement[] = [];
  let prev: string | null = null;
  for (const child of ordered) {
    const actualPrev = child.prevSiblingId ?? null;
    if (actualPrev !== prev) {
      out.push({ id: child.id, expectedPrev: prev, actualPrev });
    }
    prev = child.id;
  }
  return out;
}
