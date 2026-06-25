import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { nodeSchema } from './schema'
import type { Node } from './schema'
import { queryClient } from './query-client'
import { createNodes, deleteNodes, fetchNodes, updateNodes } from './api'

/**
 * Single source of truth for all outline nodes.
 *
 * Backed by Cloudflare D1 through a TanStack DB query collection: the queryFn
 * GETs the full node set for the authenticated user (Cloudflare Access scopes
 * it by email), and the mutation handlers POST/PATCH/DELETE through the
 * same-origin /api/nodes Worker. Mutations apply optimistically and are
 * persisted server-side; each handler returns `{ refetch: false }` so a
 * keystroke does NOT trigger a full re-GET (the editor fires many small
 * writes). Cross-device edits reconcile on window-focus refetch — see
 * query-client.ts. Why D1: docs/DECISIONS.md (D1 sync).
 *
 * A transaction can carry several mutations (a structural move relinks
 * multiple siblings), so every handler maps over `transaction.mutations`
 * rather than reading `[0]`; the Worker batches them into one D1 round trip.
 *
 * The collection interface (insert / update / delete / subscribeChanges /
 * toArray / toArrayWhenReady) is identical to the old localStorage collection,
 * so the tree store, mutations, and components are unchanged — ADR 0014 still
 * holds, and the backend-swap promise in the README is realized here.
 *
 * We let the schema drive the item type via inference rather than passing
 * `<Node>` to createCollection (the schema overload keys off StandardSchemaV1;
 * an explicit generic routes inference down the wrong branch).
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
