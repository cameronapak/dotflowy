import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { nodeSchema } from './schema'
import type { Node } from './schema'
import { queryClient } from './query-client'
import { createNodes, deleteNodes, fetchNodes, updateNodes } from './api'

/**
 * Single source of truth for all outline nodes.
 *
 * TanStack DB query collection over Wasp `getNodes` (see api.ts): mutations
 * call upsertNodes / updateNodes / deleteNodes. Optimistic locally; each handler
 * returns `{ refetch: false }` so keystrokes do not trigger a full re-query.
 * Cross-device edits reconcile on window-focus refetch (query-client.ts).
 *
 * A transaction can carry several mutations (a structural move relinks
 * multiple siblings), so every handler maps over `transaction.mutations`
 * rather than reading `[0]`.
 *
 * The collection interface (insert / update / delete / subscribeChanges /
 * toArray / toArrayWhenReady) is unchanged from the localStorage/D1 eras, so
 * the tree store, mutations, and components did not need to change.
 */
export const nodesCollection = createCollection(
  queryCollectionOptions({
    id: 'nodes',
    queryKey: ['nodes'],
    queryClient,
    queryFn: fetchNodes,
    getKey: (node: Node) => node.id,
    schema: nodeSchema,
    onInsert: async ({ transaction }) => {
      await createNodes(transaction.mutations.map((m) => m.modified as Node))
      return { refetch: false }
    },
    onUpdate: async ({ transaction }) => {
      await updateNodes(
        transaction.mutations.map((m) => ({
          id: m.key as string,
          changes: m.changes as Partial<Node>,
        })),
      )
      return { refetch: false }
    },
    onDelete: async ({ transaction }) => {
      await deleteNodes(transaction.mutations.map((m) => m.key as string))
      return { refetch: false }
    },
  }),
)

/**
 * The initial-load error, if the first `fetchNodes` settled in error, else null.
 *
 * Why this exists: the query-db-collection adapter calls `markReady()` even when
 * the fetch FAILS (it logs the error, then unblocks the collection), so
 * `toArrayWhenReady()` RESOLVES with an empty array on a server 500 / offline /
 * auth failure -- it neither rejects nor hangs. An empty array therefore means
 * "server is genuinely empty" OR "the load failed" -- indistinguishable from the
 * collection alone. Reading the underlying query state is the only way to tell
 * them apart, which first-run bootstrap needs so it doesn't seed welcome bullets
 * on top of a transient outage (see seed.ts).
 */
export function nodesLoadError(): Error | null {
  return queryClient.getQueryState(['nodes'])?.error ?? null
}
