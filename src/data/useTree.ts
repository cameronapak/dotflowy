import { useMemo } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { nodesCollection } from './collection'
import { buildTreeIndex, type TreeIndex } from './tree'

/**
 * Subscribe to all nodes and return a derived TreeIndex.
 *
 * We pass the collection directly to useLiveQuery (the "subscribe to
 * existing collection" overload), which returns `data: Array<Node>`.
 * The collection is our single source of truth so this is the whole
 * outline. Re-derives the index whenever the collection changes
 * (keystroke, insert, delete, cross-tab sync).
 */
export function useTree(): { index: TreeIndex } {
  const { data } = useLiveQuery(nodesCollection)

  const index = useMemo(() => buildTreeIndex(data ?? []), [data])

  return { index }
}
