/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Worker: serves the static SPA (via the ASSETS binding) and the
 * sync API — /api/nodes (the outline) and /api/kv (plugin side-collections).
 * Each request is routed to the current user's Durable Object (UserOutlineDO),
 * whose colocated SQLite holds that user's entire outline. See docs/DECISIONS.md.
 *
 * Identity today: the app is single-user behind Cloudflare Access / Basic Auth,
 * so `authorize()` still gates every request and `resolveUserId()` routes
 * everyone to one constant-named DO. A DO name is *permanent*, so it must never
 * be keyed by a mutable value like an email — when Better Auth lands,
 * `resolveUserId` returns the stable `session.user.id` and nothing else in the
 * data path changes.
 *
 * D1 is kept only as (1) the source for the one-time, non-destructive import of
 * a user's legacy rows into their DO (`ensureSeeded`), and (2) the future home
 * of Better Auth's identity tables. Locally (`wrangler dev`) there is no Access
 * in front, so we fall back to a fixed dev owner gated on the localhost
 * hostname, which production traffic can never present.
 */

import { UserOutlineDO } from './outline-do'
import type { Node } from './outline-do'

// Re-export the DO class so the Workers runtime can instantiate it (the
// wrangler `durable_objects` binding resolves `UserOutlineDO` from the entry).
export { UserOutlineDO }

interface Env {
  DB: D1Database
  ASSETS: Fetcher
  USER_OUTLINE: DurableObjectNamespace<UserOutlineDO>
  /** Shared secret for the HTTP Basic Auth fallback gate (set via
   *  `wrangler secret put APP_PASSWORD`). Unset -> the app is locked. */
  APP_PASSWORD?: string
  /** Owner key the legacy D1 rows are scoped under, read once during the
   *  one-time import. Defaults to 'owner'. */
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

const DEV_OWNER = 'local-dev'

// Plugin side-collections backed by the kv store. The allowlist stops a client
// writing arbitrary collection namespaces.
const KV_COLLECTIONS = new Set(['tag-colors', 'daily-index'])

function basicAuthChallenge(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="dotflowy", charset="UTF-8"' },
  })
}

/**
 * Resolve the request's owner, or return a Response that denies it. Three tiers,
 * in order: (1) **Cloudflare Access** (`Cf-Access-Authenticated-User-Email`);
 * (2) **local dev** gated on a localhost hostname; (3) **HTTP Basic Auth**
 * against `env.APP_PASSWORD`, **fail-closed if unset**. Owner is `env.APP_OWNER`
 * (default 'owner'), independent of the typed username.
 *
 * This still gates *access*. The DO routing key is derived separately in
 * `resolveUserId` so the partition key is never an email (see the file header).
 */
function authorize(request: Request, env: Env, url: URL): { owner: string } | Response {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email')
  if (email) return { owner: email }

  const host = url.hostname
  if (host === 'localhost' || host === '127.0.0.1') return { owner: DEV_OWNER }

  const expected = env.APP_PASSWORD
  if (!expected) return basicAuthChallenge() // not configured -> locked
  const [scheme, encoded] = (request.headers.get('Authorization') ?? '').split(' ')
  if (scheme !== 'Basic' || !encoded) return basicAuthChallenge()
  let decoded = ''
  try {
    decoded = atob(encoded)
  } catch {
    return basicAuthChallenge()
  }
  const pass = decoded.slice(decoded.indexOf(':') + 1)
  if (!decoded || pass !== expected) return basicAuthChallenge()
  return { owner: env.APP_OWNER || 'owner' }
}

/**
 * The Durable Object name for the current user's outline.
 *
 * LOCKED DECISION: a DO name is permanent and cannot be renamed, so it must
 * never be an email or any value that can change — keying by email would orphan
 * a user's whole outline on an email or auth-provider change. Until Better Auth
 * ships a stable `user.id`, the app is single-user, so we route everyone to one
 * constant-named DO. Better Auth replaces the constant with `session.user.id`;
 * nothing else in the data path changes. Do NOT key this off `owner`/email.
 */
const SINGLE_USER_ID = 'default'
function resolveUserId(_request: Request, _owner: string): string {
  return SINGLE_USER_ID
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
  owner: string,
): Promise<void> {
  if (await stub.isSeeded()) return
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

    // Gate EVERY path (incl. the document + assets), not just /api — a fetch()
    // 401 won't trigger the browser's Basic Auth prompt, only a navigation
    // does. Requires `run_worker_first: true` in wrangler.jsonc.
    const auth = authorize(request, env, url)
    if (auth instanceof Response) return auth
    const { owner } = auth

    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)

    const userId = resolveUserId(request, owner)
    const stub = env.USER_OUTLINE.get(env.USER_OUTLINE.idFromName(userId))

    try {
      if (url.pathname === '/api/nodes') {
        if (request.method === 'GET') await ensureSeeded(stub, env, owner)
        return await handleNodes(request, stub)
      }
      if (url.pathname === '/api/kv') {
        const collection = url.searchParams.get('collection')
        if (!collection || !KV_COLLECTIONS.has(collection)) {
          return json({ error: 'unknown collection' }, 400)
        }
        if (request.method === 'GET') await ensureSeeded(stub, env, owner)
        return await handleKv(request, stub, collection)
      }
    } catch (err) {
      return json({ error: String(err) }, 500)
    }
    return json({ error: 'not found' }, 404)
  },
} satisfies ExportedHandler<Env>
