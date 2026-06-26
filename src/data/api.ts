import type { Node } from './schema'
import type { ChangeOp } from './realtime'

/**
 * Thin REST client for the /api/nodes Worker (which routes to the user's
 * Durable Object). Same-origin, so the Better Auth session cookie rides along
 * automatically. The collection's mutation handlers (collection.ts) call
 * create/update/delete on the write path; the initial snapshot + live reads now
 * arrive over the sync socket (realtime.ts), not a GET here. See
 * docs/DECISIONS.md.
 *
 * STRUCTURAL writes (insert/delete a bullet — anything that relinks the sibling
 * chain) go through `persistBatch` instead: one request carrying every op, so
 * the DO commits them as one atomic frame. The per-type create/update/delete
 * helpers below stay for FIELD edits (text, completed, …) and the first-run
 * seed. See structural.ts and PLAN.md.
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

/**
 * Persist a structural mutation as one atomic batch. The DO applies every op and
 * commits a SINGLE change frame, returning its sequence number; the caller
 * (`runStructural`) waits for that seq to echo back before dropping its
 * optimistic overlay. All-or-nothing: a failed request rolls the whole op back.
 */
export async function persistBatch(ops: ChangeOp[]): Promise<{ seq: number }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops }),
  })
  if (!res.ok) throw new Error(`POST ${ENDPOINT} (batch) -> ${res.status}`)
  return (await res.json()) as { seq: number }
}

export const createNodes = (nodes: Node[]): Promise<void> =>
  send('POST', { nodes })

export const updateNodes = (
  updates: { id: string; changes: Partial<Node> }[],
): Promise<void> => send('PATCH', { updates })

export const deleteNodes = (ids: string[]): Promise<void> =>
  send('DELETE', { ids })
