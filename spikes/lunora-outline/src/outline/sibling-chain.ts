import type { OutlineNode } from "./types.js";

/**
 * Port of Dotflowy `src/data/sibling-chain.ts` — READ side of the sibling-chain
 * invariant (ADR 0009). Order by following `prevSiblingId`; report disagreements.
 */

export function orderSiblings(unordered: OutlineNode[]): OutlineNode[] {
  if (unordered.length <= 1) return unordered;

  const byPrev = new Map<string | null, OutlineNode>();
  for (const n of unordered) byPrev.set(n.prevSiblingId, n);

  const ordered: OutlineNode[] = [];
  const idsInChain = new Set<string>();
  let cursor: string | null = null;
  let guard = unordered.length + 1;
  while (guard-- > 0) {
    const next = byPrev.get(cursor);
    if (!next) break;
    ordered.push(next);
    idsInChain.add(next.id);
    cursor = next.id;
  }

  for (const n of unordered) {
    if (!idsInChain.has(n.id)) ordered.push(n);
  }

  return ordered;
}

export type ChainDisagreement = {
  id: string;
  expectedPrev: string | null;
  actualPrev: string | null;
};

export function chainDisagreements(
  ordered: OutlineNode[],
): ChainDisagreement[] {
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
