import * as errore from 'errore'
import { nodesCollection } from './collection'
import { now } from './tree'
import type { Node } from './schema'

/**
 * One-time import of a pre-server outline from localStorage into Postgres.
 *
 * Before the Wasp migration the outline lived in a TanStack DB localStorage
 * collection under `dotflowy-oss:nodes`. This pushes it into the signed-in
 * user's silo once, the first time the app loads against an empty server.
 *
 * Guards (all three must hold to import):
 *  - the `d1-imported` flag is absent — so we never re-import after the user has
 *    legitimately emptied their server outline,
 *  - localStorage actually holds legacy nodes,
 *  - the server silo is EMPTY — never clobber server data.
 *
 * Non-destructive: the legacy key is left intact as a backup. Returns true only
 * when it actually wrote nodes (so the caller skips the first-run seed).
 */
const LEGACY_KEY = 'dotflowy-oss:nodes'
const IMPORTED_FLAG = 'dotflowy-oss:d1-imported'

export async function importLegacyNodes(): Promise<boolean> {
  if (typeof localStorage === 'undefined') return false
  if (localStorage.getItem(IMPORTED_FLAG)) return false

  const legacy = readLegacyNodes()
  if (legacy.length === 0) return false // nothing to migrate

  // Never overwrite a populated D1 (already-migrated user / another device).
  const existing = await nodesCollection.toArrayWhenReady()
  if (existing.length > 0) {
    // The legacy store is obsolete everywhere now — mark done and leave it be.
    localStorage.setItem(IMPORTED_FLAG, String(now()))
    return false
  }

  // One array insert == one transaction == one batched upsertNodes call.
  nodesCollection.insert(legacy)
  localStorage.setItem(IMPORTED_FLAG, String(now()))
  return true
}

/** Pull and normalize the legacy localStorage payload into a Node[]. Tolerant
 *  of malformed JSON and stray non-node keys (returns only what parses). */
function readLegacyNodes(): Node[] {
  const raw = localStorage.getItem(LEGACY_KEY)
  if (!raw) return []
  // Sync boundary (JSON.parse on a possibly-corrupt blob): errore.try turns the
  // throw into a value so the parse failure falls through to the [] fallback.
  const parsed = errore.try(() => JSON.parse(raw) as Record<string, unknown>)
  if (parsed instanceof Error) return []
  if (!parsed || typeof parsed !== 'object') return []
  const out: Node[] = []
  for (const entry of Object.values(parsed)) {
    const node = normalizeNode((entry as { data?: unknown } | null)?.data)
    if (node) out.push(node)
  }
  return out
}

/** Coerce a stored value into a schema-valid Node, or null if it isn't one.
 *  Defensive about older payloads missing a field the live schema requires
 *  (the old app's localStorage migrations backfilled isTask/bookmarkedAt, but a
 *  store predating them shouldn't fail the whole import). */
function normalizeNode(d: unknown): Node | null {
  if (!d || typeof d !== 'object') return null
  const o = d as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  const ts = now()
  return {
    id: o.id,
    parentId: typeof o.parentId === 'string' ? o.parentId : null,
    prevSiblingId: typeof o.prevSiblingId === 'string' ? o.prevSiblingId : null,
    text: typeof o.text === 'string' ? o.text : '',
    isTask: o.isTask === true,
    completed: o.completed === true,
    collapsed: o.collapsed === true,
    bookmarkedAt: typeof o.bookmarkedAt === 'number' ? o.bookmarkedAt : null,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : ts,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : ts,
  }
}
