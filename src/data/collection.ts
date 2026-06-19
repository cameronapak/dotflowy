import { createCollection } from '@tanstack/react-db'
import { localStorageCollectionOptions } from '@tanstack/react-db'
import { nodeSchema } from './schema'
import type { Node } from './schema'

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
    storageKey: 'workflowy-oss:nodes',
    getKey: (node: Node) => node.id,
    schema: nodeSchema,
  }),
)
