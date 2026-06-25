import type { Node } from './schema'
import {
  getNodes,
  upsertNodes,
  updateNodes as updateNodesAction,
  deleteNodes as deleteNodesAction,
} from 'wasp/client/operations'

/**
 * The outline sync boundary (PRD Phase 3). Wraps the Wasp client operations
 * (generated from src/nodes/operations.ts) so the nodes collection keeps its
 * fetchNodes / createNodes / updateNodes / deleteNodes interface unchanged —
 * collection.ts didn't change. The old same-origin /api/nodes Worker fetch is
 * gone; the Wasp session scopes every call to context.user.id server-side, so
 * there's no owner header to send. Wire shape is still the legacy epoch-ms
 * `Node` (schema.ts); operations.ts maps it to Prisma DateTime at the boundary.
 */

/** Complete server state for the signed-in user. The query collection treats
 *  this as authoritative, so it must always return every owned node. */
export async function fetchNodes(): Promise<Node[]> {
  return getNodes()
}

export const createNodes = (nodes: Node[]): Promise<void> =>
  upsertNodes({ nodes })

export const updateNodes = (
  updates: { id: string; changes: Partial<Node> }[],
): Promise<void> => updateNodesAction({ updates })

export const deleteNodes = (ids: string[]): Promise<void> =>
  deleteNodesAction({ ids })
