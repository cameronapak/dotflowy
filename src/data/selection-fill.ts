import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { VisibleRow } from "./visible-order";

import {
  getSelectionState,
  subscribeSelection,
  type SelectionData,
  type SelectionEdge,
} from "./selection-state";

/**
 * Per-row selection FILL for the windowed list (2e-2, ADR 0019/0022). The old
 * recursive render only marked a selected ROOT, because its descendants were
 * DOM-nested inside the root's `<li>` and inherited the tint for free. The flat
 * list has no such nesting -- every row is its own absolutely positioned
 * sibling -- so a selected root's descendants need their OWN `data-selected`
 * value or they render untinted (the windowed-subtree-tint bug; affects any
 * node, not just mirrors).
 *
 * `SelectionFill` reuses {@link SelectionEdge}'s vocabulary (same four values,
 * same CSS) -- only what counts as "covered" changes: every visible row inside
 * the selection's span, not just its roots.
 */
export type SelectionFill = SelectionEdge;

/**
 * One walk of the current flat row list, marking the contiguous covered span:
 * each selected root, plus every visible descendant beneath it (by `depth`,
 * mirroring how `buildVisibleRows` already flattens collapse/hide/filter), as
 * ONE slab from the first covered row to the last. Corner rounding lands on the
 * span's actual first/last ROW -- which for a root with children is a
 * descendant, not the root -- not on `rootIds[0]`/`rootIds[last]` (the old
 * root-only edge map's anchors).
 *
 * Coverage is matched by row id against `rootIds`, the same identity the old
 * `edgeMapFor` used -- so it inherits the same known limitation: a node
 * rendered at two row keys at once (a windowed mirror descendant whose source
 * is ALSO visible elsewhere) covers both occurrences. Killing that fully needs
 * the selection itself to carry a row key, not just a node id -- out of scope
 * here (issue 03's 2e bullet tracks it separately); this only fixes the named
 * bug, that a covered descendant gets no tint at all.
 */
function computeFillMap(
  rows: VisibleRow[],
  data: SelectionData | null,
): Map<string, SelectionFill> {
  const map = new Map<string, SelectionFill>();
  const rootIds = data?.rootIds as readonly string[] | undefined;
  if (!rootIds || rootIds.length === 0) return map;
  const rootSet = new Set(rootIds);
  const covered: string[] = [];
  let openDepth: number | null = null;
  for (const row of rows) {
    if (openDepth !== null && row.depth > openDepth) {
      covered.push(row.key);
      continue;
    }
    openDepth = null;
    if (rootSet.has(row.id)) {
      covered.push(row.key);
      openDepth = row.depth;
    }
  }
  if (covered.length === 0) return map;
  if (covered.length === 1) {
    map.set(covered[0]!, "single");
    return map;
  }
  map.set(covered[0]!, "top");
  map.set(covered[covered.length - 1]!, "bottom");
  for (let i = 1; i < covered.length - 1; i++) map.set(covered[i]!, "middle");
  return map;
}

const EMPTY_ROWS: VisibleRow[] = [];
let rows: VisibleRow[] = EMPTY_ROWS;
let fillMap: Map<string, SelectionFill> = new Map();
const listeners = new Set<() => void>();
let started = false;

function recompute() {
  fillMap = computeFillMap(rows, getSelectionState());
  for (const l of listeners) l();
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  subscribeSelection(recompute);
}

/**
 * Mirror the editor's current flat row list into the fill computation (mirrors
 * `useSyncViewState`'s pattern). Call once in OutlineEditor, right after
 * `useVisibleRows`. The write runs in an effect, so nothing here trips the
 * React Compiler's ref-during-render bailout; `rows` only changes identity on a
 * structural edit (collapse, insert, move, filter), never on a keystroke.
 */
export function useSyncSelectionFillRows(nextRows: VisibleRow[]): void {
  useEffect(() => {
    rows = nextRows;
    recompute();
  }, [nextRows]);
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Per-row subscription to this row's fill: a row re-renders only when ITS OWN
 * value changes (ADR 0014, the `useIsProtected` shape), keyed by `row.key` (not
 * the bare node id, so a windowed mirror descendant and its source's canonical
 * row -- different keys, same id -- are independent reads). Returns null when
 * this row isn't covered.
 */
export function useSelectionFill(key: string): SelectionFill | null {
  const getSnapshot = useCallback(() => fillMap.get(key) ?? null, [key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
