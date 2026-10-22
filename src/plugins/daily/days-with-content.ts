// Shared content-dot subscription for the week strip + month picker
// (ADR 0054 / 0055): a day key lights when it maps to a node WITH children.

import { useCallback, useRef, useSyncExternalStore } from "react";

import { getTreeIndex, subscribeTree } from "../../data/tree-store";
import { getMappedId, subscribeDailyIndex } from "./daily-index";

const EMPTY_KEYSET: ReadonlySet<string> = new Set();

function subscribeContentSources(cb: () => void): () => void {
  const untree = subscribeTree(cb);
  const undaily = subscribeDailyIndex(cb);
  return () => {
    untree();
    undaily();
  };
}

/**
 * The subset of `dayKeys` that have a dot: the day key maps to a node AND that
 * node has at least one child ("you wrote something here" -- ADR 0054, decision
 * 6; existence alone would light every seed-free peek). Caches on a stable string
 * signature so the returned Set keeps its identity until the dotted set actually
 * changes, as `useSyncExternalStore` requires. `dayKeys` must be referentially
 * stable across renders (the caller memoizes it on the visible week/grid).
 */
export function useDaysWithContent(dayKeys: string[]): ReadonlySet<string> {
  const cacheRef = useRef<{ sig: string; set: Set<string> } | null>(null);
  const getSnapshot = useCallback(() => {
    const index = getTreeIndex();
    const present: string[] = [];
    for (const key of dayKeys) {
      const id = getMappedId(key);
      if (id && (index.childrenByParent.get(id)?.length ?? 0) > 0)
        present.push(key);
    }
    const sig = present.join(",");
    if (!cacheRef.current || cacheRef.current.sig !== sig)
      cacheRef.current = { sig, set: new Set(present) };
    return cacheRef.current.set;
  }, [dayKeys]);
  return useSyncExternalStore(
    subscribeContentSources,
    getSnapshot,
    () => EMPTY_KEYSET,
  );
}
