/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Worker: serves the static SPA (via the ASSETS binding) and the
 * /api/nodes sync API backed by D1.
 *
 * Routing: `run_worker_first: ["/api/*"]` in wrangler.jsonc means this Worker
 * only runs for /api/* — every other path is served directly from static
 * assets (with the SPA fallback to index.html). The non-/api branch below is
 * just a safety net for the navigation case.
 *
 * Identity: the app sits behind Cloudflare Access (configured on the zone), so
 * every request that reaches this Worker in production carries a verified
 * `Cf-Access-Authenticated-User-Email` header. Every row is scoped to that
 * email via the `owner` column. Locally (`wrangler dev`) there is no Access in
 * front, so we fall back to a fixed dev owner — gated on the request hostname
 * being localhost, which production traffic can never present (Access fronts
 * the real hostname). Hardening path: validate the Access JWT signature
 * (`Cf-Access-Jwt-Assertion`) against the team's JWKS. See docs/DECISIONS.md (D1 sync).
 */

interface Env {
  DB: D1Database
  ASSETS: Fetcher
  /** Shared secret for the HTTP Basic Auth fallback gate (set via
   *  `wrangler secret put APP_PASSWORD`). Unset -> the app is locked. */
  APP_PASSWORD?: string
  /** Owner key to scope data under when authed via Basic Auth. Defaults to
   *  'owner'; set it to your future Access email so a later switch to Access
   *  keeps the same rows. */
  APP_OWNER?: string
}

/** A row as stored in SQLite — booleans are 0/1 integers. */
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

/** A node as the client speaks it — booleans are real booleans. */
interface Node {
  id: string
  parentId: string | null
  prevSiblingId: string | null
  text: string
  isTask: boolean
  completed: boolean
  collapsed: boolean
  bookmarkedAt: number | null
  createdAt: number
  updatedAt: number
}

const DEV_OWNER = 'local-dev'

// Plugin side-collections backed by the generic `kv` table (ADR 0024). The
// allowlist stops a client writing arbitrary collection namespaces.
const KV_COLLECTIONS = new Set(['tag-colors', 'daily-index'])

/** Columns a client is allowed to write, mapped to their bool-ness. */
const BOOL_COLUMNS = new Set(['isTask', 'completed', 'collapsed'])
const WRITABLE_COLUMNS = new Set([
  'parentId',
  'prevSiblingId',
  'text',
  'isTask',
  'completed',
  'collapsed',
  'bookmarkedAt',
  'createdAt',
  'updatedAt',
])

function basicAuthChallenge(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="dotflowy", charset="UTF-8"' },
  })
}

/**
 * Resolve the request's owner, or return a Response that denies it.
 *
 * Three tiers, in order:
 *  1. **Cloudflare Access** (preferred / future): a verified
 *     `Cf-Access-Authenticated-User-Email` header → owner = that email.
 *  2. **Local dev**: no Access in front of `wrangler dev`, gated on a localhost
 *     hostname (prod traffic can't present one) → owner = DEV_OWNER.
 *  3. **Production without Access**: a single-user **HTTP Basic Auth** gate
 *     (`env.APP_PASSWORD`, set via `wrangler secret put`). The browser prompts
 *     on the document load and then sends the header on every request, incl. the
 *     `/api` fetches. **Fail closed** if the secret is unset. Owner is
 *     `env.APP_OWNER` (default 'owner') — independent of the typed username, so
 *     any username works and the data stays unified. See ADR 0023 / 0025.
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

function toSqlValue(key: string, value: unknown): unknown {
  if (BOOL_COLUMNS.has(key)) return value ? 1 : 0
  return value ?? null
}

/** Build a scoped UPDATE from a partial change set. Column names come only from
 *  the WRITABLE_COLUMNS allowlist, so the dynamic SQL can't be injected. */
function buildUpdate(
  env: Env,
  owner: string,
  id: string,
  changes: Record<string, unknown>,
): D1PreparedStatement | null {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(changes)) {
    if (!WRITABLE_COLUMNS.has(k)) continue
    sets.push(`${k} = ?`)
    vals.push(toSqlValue(k, v))
  }
  if (!sets.length) return null
  vals.push(id, owner)
  return env.DB.prepare(
    `UPDATE nodes SET ${sets.join(', ')} WHERE id = ? AND owner = ?`,
  ).bind(...vals)
}

async function handleNodes(
  request: Request,
  env: Env,
  owner: string,
): Promise<Response> {
  switch (request.method) {
    case 'GET': {
      // queryFn treats this as COMPLETE server state, so it must return every
      // node the user owns (filtering happens client-side / per zoom view).
      const { results } = await env.DB.prepare(
        'SELECT id, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, createdAt, updatedAt FROM nodes WHERE owner = ?',
      )
        .bind(owner)
        .all<NodeRow>()
      return json(results.map(rowToNode))
    }
    case 'POST': {
      const { nodes } = (await request.json()) as { nodes: Node[] }
      if (!nodes?.length) return json({ ok: true })
      // Upsert (idempotent re-insert of your own nodes); the owner guard on the
      // conflict path stops one owner overwriting another's row.
      const stmt = env.DB.prepare(
        `INSERT INTO nodes (id, owner, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           parentId=excluded.parentId, prevSiblingId=excluded.prevSiblingId, text=excluded.text,
           isTask=excluded.isTask, completed=excluded.completed, collapsed=excluded.collapsed,
           bookmarkedAt=excluded.bookmarkedAt, updatedAt=excluded.updatedAt
         WHERE nodes.owner = excluded.owner`,
      )
      await env.DB.batch(
        nodes.map((n) =>
          stmt.bind(
            n.id,
            owner,
            n.parentId,
            n.prevSiblingId,
            n.text,
            n.isTask ? 1 : 0,
            n.completed ? 1 : 0,
            n.collapsed ? 1 : 0,
            n.bookmarkedAt,
            n.createdAt,
            n.updatedAt,
          ),
        ),
      )
      return json({ ok: true })
    }
    case 'PATCH': {
      const { updates } = (await request.json()) as {
        updates: { id: string; changes: Record<string, unknown> }[]
      }
      if (!updates?.length) return json({ ok: true })
      const stmts = updates
        .map((u) => buildUpdate(env, owner, u.id, u.changes))
        .filter((s): s is D1PreparedStatement => s !== null)
      if (stmts.length) await env.DB.batch(stmts)
      return json({ ok: true })
    }
    case 'DELETE': {
      const { ids } = (await request.json()) as { ids: string[] }
      if (!ids?.length) return json({ ok: true })
      const stmt = env.DB.prepare('DELETE FROM nodes WHERE id = ? AND owner = ?')
      await env.DB.batch(ids.map((id) => stmt.bind(id, owner)))
      return json({ ok: true })
    }
    default:
      return json({ error: 'method not allowed' }, 405)
  }
}

/**
 * Generic key/value store for the plugin side-collections (tag colors, the
 * daily index). One table, namespaced by `collection`; `value` is the
 * JSON-stringified item. The client api computes each row's `key` from the
 * collection's getKey (kv-api.ts), so the Worker stores it opaquely. GET returns
 * the COMPLETE set for one collection (the query collection treats it as
 * authoritative). See docs/DECISIONS.md (D1 sync).
 */
async function handleKv(
  request: Request,
  env: Env,
  owner: string,
  collection: string,
): Promise<Response> {
  switch (request.method) {
    case 'GET': {
      const { results } = await env.DB.prepare(
        'SELECT value FROM kv WHERE owner = ? AND collection = ?',
      )
        .bind(owner, collection)
        .all<{ value: string }>()
      return json(results.map((r) => JSON.parse(r.value)))
    }
    case 'POST': {
      // Upsert. Insert and update both land here (the items are tiny key->value
      // rows, so we store the whole value rather than diffing).
      const { rows } = (await request.json()) as {
        rows: { key: string; value: unknown }[]
      }
      if (!rows?.length) return json({ ok: true })
      const stmt = env.DB.prepare(
        `INSERT INTO kv (owner, collection, key, value, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner, collection, key) DO UPDATE SET
           value = excluded.value, updatedAt = excluded.updatedAt`,
      )
      const ts = Date.now()
      await env.DB.batch(
        rows.map((r) =>
          stmt.bind(owner, collection, r.key, JSON.stringify(r.value), ts),
        ),
      )
      return json({ ok: true })
    }
    case 'DELETE': {
      const { keys } = (await request.json()) as { keys: string[] }
      if (!keys?.length) return json({ ok: true })
      const stmt = env.DB.prepare(
        'DELETE FROM kv WHERE owner = ? AND collection = ? AND key = ?',
      )
      await env.DB.batch(keys.map((k) => stmt.bind(owner, collection, k)))
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
    // does. Requires `run_worker_first: true` in wrangler.jsonc so the Worker
    // sees the document request.
    const auth = authorize(request, env, url)
    if (auth instanceof Response) return auth
    const { owner } = auth

    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)

    try {
      if (url.pathname === '/api/nodes') {
        return await handleNodes(request, env, owner)
      }
      if (url.pathname === '/api/kv') {
        const collection = url.searchParams.get('collection')
        if (!collection || !KV_COLLECTIONS.has(collection)) {
          return json({ error: 'unknown collection' }, 400)
        }
        return await handleKv(request, env, owner, collection)
      }
    } catch (err) {
      return json({ error: String(err) }, 500)
    }
    return json({ error: 'not found' }, 404)
  },
} satisfies ExportedHandler<Env>
