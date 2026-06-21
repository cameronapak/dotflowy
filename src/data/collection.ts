import { createCollection } from '@tanstack/react-db'
import { localStorageCollectionOptions } from '@tanstack/react-db'
import { nodeSchema } from './schema'
import type { Node } from './schema'

const STORAGE_KEY = 'dotflowy-oss:nodes'

/**
 * One-time backfill: nodes stored before `isTask` existed lack the field,
 * which the (intentionally default-less) schema would reject on load. Patch
 * the raw localStorage payload before the collection reads it so validation
 * only ever sees complete rows. Runs at import; browser-only (SPA mode).
 */
function migrateAddIsTask() {
  if (typeof localStorage === 'undefined') return
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return
  try {
    const store = JSON.parse(raw) as Record<string, { data?: Partial<Node> }>
    let changed = false
    for (const entry of Object.values(store)) {
      if (entry?.data && entry.data.isTask === undefined) {
        entry.data.isTask = false
        changed = true
      }
    }
    if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Corrupt payload: leave it for the collection to handle.
  }
}

migrateAddIsTask()

/**
 * Single source of truth for all outline nodes.
 *
 * Backed by localStorage via TanStack DB's LocalStorageCollection.
 * We mutate directly (collection.insert / update / delete) and the
 * collection handles persistence + cross-tab sync automatically.
 *
 * We deliberately let the schema drive the collection's item type via
 * inference rather than passing `<Node>` to createCollection. The
 * schema overload of createCollection keys off `T extends
 * StandardSchemaV1`; explicitly typing T as Node collides with that
 * overload and routes inference down the wrong branch.
 *
 * Backend swap path: when we want real-time multi-device sync, replace
 * localStorageCollectionOptions with electricCollectionOptions
 * pointing at Postgres + Electric. The collection interface (insert /
 * update / delete / useLiveQuery) stays identical, so none of the
 * components or tree logic needs to change.
 */
export const nodesCollection = createCollection(
  localStorageCollectionOptions({
    id: 'nodes',
    storageKey: STORAGE_KEY,
    getKey: (node: Node) => node.id,
    schema: nodeSchema,
  }),
)
