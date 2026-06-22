import { useTreeIndex } from './tree-store'
import type { TreeIndex } from './tree'

/**
 * Subscribe to the whole derived TreeIndex.
 *
 * Backed by the shared tree store (see tree-store.ts), which holds one
 * subscription to the nodes collection and re-derives the index on change.
 * This is the whole-index view used by readers that genuinely need everything
 * (the quick-switcher search, bookmarks). The outline editor renders through
 * the narrow `useNode` / `useVisibleChildIds` slices instead, so a keystroke
 * re-renders only the bullet that changed. See ADR 0014.
 */
export function useTree(): { index: TreeIndex } {
  return { index: useTreeIndex() }
}
