/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Worker: serves the static SPA (via the ASSETS binding) and the
 * sync API — /api/nodes (the outline) and /api/kv (plugin side-collections).
 * Each request is routed to the current user's Durable Object (UserOutlineDO),
 * whose colocated SQLite holds that user's entire outline. See docs/DECISIONS.md.
 *
 * Identity = Better Auth (worker/auth.ts), email + password self-serve signup,
 * sessions in D1. The static shell is PUBLIC (the login screen must load); only
 * the data API (/api/nodes, /api/kv) is gated, by a valid session. The DO
 * routing key is the session's stable `user.id` — a DO name is *permanent*, so
 * it must never be an email or any value that can change (see resolveUserId).
 *
 * D1 holds (1) Better Auth's identity tables (user/session/account), and (2) the
 * pre-DO legacy outline rows, kept only as the source for the one-time,
 * non-destructive import into the owner's DO (`ensureSeeded`).
 */

import { UserOutlineDO } from './outline-do'
import type { Node } from './outline-do'
import { createAuth } from './auth'
import type { AuthEnv } from './auth'

// Re-export the DO class so the Workers runtime can instantiate it (the
// wrangler `durable_objects` binding resolves `UserOutlineDO` from the entry).
export { UserOutlineDO }

interface Env extends AuthEnv {
  DB: D1Database
  ASSETS: Fetcher
  USER_OUTLINE: DurableObjectNamespace<UserOutlineDO>
  /** The owner's Better Auth `user.id`. When set, that one account routes to
   *  the constant 'default' DO (where the pre-auth outline already lives), so
   *  the owner's existing data carries over with zero copy. Everyone else
   *  routes to their own `user.id`. See resolveUserId. */
  OWNER_USER_ID?: string
  /** Owner key the legacy D1 rows are scoped under, read once during the
   *  one-time import into the owner's DO. Defaults to 'owner'. */
  APP_OWNER?: string
}

/** A legacy D1 node row (booleans as 0/1). Only read during the one-time import
 *  of pre-DO data into a user's Durable Object. */
interface NodeRow {
  id: string
  parentId: string | null
  prevSiblingId: string | null
  text: string
  isTask: number
  completed: number
  collapsed: number
  bookmarkedAt: number | null
  createdAt: number
  updatedAt: number
}

// Plugin side-collections backed by the kv store. The allowlist stops a client
// writing arbitrary collection namespaces.
const KV_COLLECTIONS = new Set(['tag-colors', 'daily-index'])

/**
 * The Durable Object name for the signed-in user's outline.
 *
 * LOCKED DECISION: a DO name is permanent and cannot be renamed, so it must
 * never be an email or any value that can change — keying by email would orphan
 * a user's whole outline on an email or auth-provider change. We key by the
 * session's stable `user.id`. Do NOT key this off the email.
 *
 * The one exception is the owner-continuity bridge: the pre-auth outline lives
 * in the constant 'default' DO (seeded from legacy D1). Setting OWNER_USER_ID to
 * the owner's `user.id` maps that one account back to 'default', carrying their
 * existing data over with zero copy. Removable once that data is wherever it
 * belongs.
 */
const OWNER_DO_ID = 'default'
function resolveUserId(sessionUserId: string, env: Env): string {
  if (env.OWNER_USER_ID && sessionUserId === env.OWNER_USER_ID) return OWNER_DO_ID
  return sessionUserId
}

function rowToNode(r: NodeRow): Node {
  return {
    id: r.id,
    parentId: r.parentId,
    prevSiblingId: r.prevSiblingId,
    text: r.text,
    isTask: !!r.isTask,
    completed: !!r.completed,
    collapsed: !!r.collapsed,
    bookmarkedAt: r.bookmarkedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * One-time, non-destructive copy of the owner's legacy D1 rows into their DO.
 * Idempotent — the DO marks itself seeded and short-circuits thereafter. Runs
 * on reads only (the client always GETs before it writes). Remove this and the
 * D1 node/kv tables once every user is migrated.
 */
async function ensureSeeded(
  stub: DurableObjectStub<UserOutlineDO>,
  env: Env,
): Promise<void> {
  if (await stub.isSeeded()) return
  const owner = env.APP_OWNER || 'owner'
  let nodeRows: NodeRow[] = []
  let kvRows: { collection: string; key: string; value: string }[] = []
  try {
    nodeRows = (
      await env.DB.prepare(
        'SELECT id, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, createdAt, updatedAt FROM nodes WHERE owner = ?',
      )
        .bind(owner)
        .all<NodeRow>()
    ).results
    kvRows = (
      await env.DB.prepare('SELECT collection, key, value FROM kv WHERE owner = ?')
        .bind(owner)
        .all<{ collection: string; key: string; value: string }>()
    ).results
  } catch (err) {
    // No legacy tables (fresh deploy / dev with un-migrated D1) -> nothing to
    // import. Any OTHER D1 error: rethrow so we DON'T mark the DO seeded and the
    // import retries on the next load instead of silently hiding real data.
    if (!/no such table/i.test(String(err))) throw err
  }
  await stub.seed({
    nodes: nodeRows.map(rowToNode),
    kv: kvRows.map((r) => ({ collection: r.collection, key: r.key, value: JSON.parse(r.value) })),
  })
}

async function handleNodes(
  request: Request,
  stub: DurableObjectStub<UserOutlineDO>,
): Promise<Response> {
  switch (request.method) {
    case 'GET':
      return json(await stub.getNodes())
    case 'POST': {
      const { nodes } = (await request.json()) as { nodes: Node[] }
      if (nodes?.length) await stub.upsertNodes(nodes)
      return json({ ok: true })
    }
    case 'PATCH': {
      const { updates } = (await request.json()) as {
        updates: { id: string; changes: Record<string, unknown> }[]
      }
      if (updates?.length) await stub.patchNodes(updates)
      return json({ ok: true })
    }
    case 'DELETE': {
      const { ids } = (await request.json()) as { ids: string[] }
      if (ids?.length) await stub.deleteNodes(ids)
      return json({ ok: true })
    }
    default:
      return json({ error: 'method not allowed' }, 405)
  }
}

async function handleKv(
  request: Request,
  stub: DurableObjectStub<UserOutlineDO>,
  collection: string,
): Promise<Response> {
  switch (request.method) {
    case 'GET':
      return json(await stub.getKv(collection))
    case 'POST': {
      // `?op=claim` is the atomic get-or-create: insert the value only if the
      // key is absent, return the authoritative one. Used by the daily plugin to
      // race-safely create today's note / the container (the DO serializes it).
      if (new URL(request.url).searchParams.get('op') === 'claim') {
        const { key, value } = (await request.json()) as {
          key: string
          value: unknown
        }
        return json({ value: await stub.getOrCreateKv(collection, key, value) })
      }
      const { rows } = (await request.json()) as {
        rows: { key: string; value: unknown }[]
      }
      if (rows?.length) await stub.upsertKv(collection, rows)
      return json({ ok: true })
    }
    case 'DELETE': {
      const { keys } = (await request.json()) as { keys: string[] }
      if (keys?.length) await stub.deleteKv(collection, keys)
      return json({ ok: true })
    }
    default:
      return json({ error: 'method not allowed' }, 405)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // The static shell + assets are PUBLIC so the login screen can load. Serve
    // them without instantiating auth — only the data API is gated, below.
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)

    const auth = createAuth(env)

    // Better Auth owns everything under /api/auth/* (sign-up/in/out, session).
    if (url.pathname.startsWith('/api/auth/')) return auth.handler(request)

    // Identity = the validated session's stable user id. No session -> 401.
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) return json({ error: 'unauthorized' }, 401)

    const userId = resolveUserId(session.user.id, env)
    const stub = env.USER_OUTLINE.get(env.USER_OUTLINE.idFromName(userId))

    try {
      // Only the owner's DO ('default') has legacy D1 rows to import; new users
      // start empty, so skip the import (and its D1 query) for them.
      const maybeSeed =
        request.method === 'GET' && userId === OWNER_DO_ID
          ? ensureSeeded(stub, env)
          : Promise.resolve()

      // Real-time sync: a WebSocket upgrade, forwarded to the caller's DO, which
      // hibernation-accepts it and streams outline changes. The session is
      // already validated above, so the socket only ever opens for an authed
      // user. Seed first (owner only) so the DO's initial snapshot includes any
      // imported legacy rows — the live client no longer GETs /api/nodes.
      if (url.pathname === '/api/sync') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return json({ error: 'expected a websocket upgrade' }, 426)
        }
        await maybeSeed
        return await stub.fetch(request)
      }

      if (url.pathname === '/api/nodes') {
        await maybeSeed
        return await handleNodes(request, stub)
      }
      if (url.pathname === '/api/kv') {
        const collection = url.searchParams.get('collection')
        if (!collection || !KV_COLLECTIONS.has(collection)) {
          return json({ error: 'unknown collection' }, 400)
        }
        await maybeSeed
        return await handleKv(request, stub, collection)
      }
    } catch (err) {
      return json({ error: String(err) }, 500)
    }
    return json({ error: 'not found' }, 404)
  },
} satisfies ExportedHandler<Env>
