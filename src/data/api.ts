import type { Node } from './schema'

/**
 * Thin REST client for the /api/nodes Worker (which routes to the user's
 * Durable Object). Same-origin, so the Better Auth session cookie rides along
 * automatically. The collection's mutation handlers (collection.ts) call
 * create/update/delete on the write path; the initial snapshot + live reads now
 * arrive over the sync socket (realtime.ts), not a GET here. See
 * docs/DECISIONS.md.
 */

const ENDPOINT = '/api/nodes'

async function send(method: string, body: unknown): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${ENDPOINT} -> ${res.status}`)
}

export const createNodes = (nodes: Node[]): Promise<void> =>
  send('POST', { nodes })

export const updateNodes = (
  updates: { id: string; changes: Partial<Node> }[],
): Promise<void> => send('PATCH', { updates })

export const deleteNodes = (ids: string[]): Promise<void> =>
  send('DELETE', { ids })
