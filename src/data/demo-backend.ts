/**
 * Anonymous, in-memory demo backend for the landing hero (Approach B).
 *
 * The landing page embeds the REAL `OutlineEditor` in an iframe pointed at the
 * app with `?demo=1`. In that mode the app must run with NO auth and NO Worker/
 * Durable Object — every write stays in the browser. This module is the browser
 * port of `e2e/fixtures.ts` `seedOutline`: it monkeypatches `globalThis.fetch`
 * (the REST write seam — `/api/nodes`, `/api/kv`) and `globalThis.WebSocket`
 * (the sync read seam — `/api/sync`) with an in-memory `Map` that speaks the
 * exact same Worker/DO wire contract the e2e mock does. The real
 * `collection.ts` → `realtime.ts` → `nodes-client-effect.ts` path runs
 * unchanged; only the transport underneath is faked.
 *
 * Why a global monkeypatch rather than an Effect-layer swap: the sync socket's
 * WebSocket constructor is `Socket.layerWebSocketConstructorGlobal`, which reads
 * `globalThis.WebSocket` LAZILY at connect time (repos/effect-smol Socket.ts).
 * So patching the global before the collection's first subscribe is enough — no
 * change to runtime.ts / collection.ts / realtime.ts, and no coupling.
 *
 * The auth boundary: demo mode NEVER calls a real `/api` route. `AuthGate`
 * bypasses `useSession()` (root __root.tsx), and this backend serves every
 * `/api/*` request from memory or stubs it — none reach the network (the
 * fetch patch matches `/api/nodes`, `/api/kv`, `/api/unfurl`, `/api/auth/get-
 * session`; any other `/api/*` or `/mcp` gets a 404 rather than the live
 * Worker). There is no real user, no real data, and no authenticated request —
 * the whole thing is a sandbox that evaporates on reload.
 */

import { demoSeedNodes, demoSeedKv } from './demo-seed'
import type { Node } from './wire-schema'

// --- Demo-mode latch --------------------------------------------------------

// Latched once, from the URL, on first read. The iframe src is `/?demo=1`; we
// also accept an `/embed` path prefix for a future dedicated route. Latched (not
// re-derived) so it stays true across a zoom navigation to `/$nodeId`, whose URL
// no longer carries the param.
let demo: boolean | undefined

/** True when the app is running as the anonymous landing demo. Stable for the
 *  whole page session once first read. Always false server-side (no window). */
export function isDemoMode(): boolean {
  if (demo === undefined) {
    demo =
      typeof window !== 'undefined' &&
      (new URLSearchParams(window.location.search).has('demo') ||
        window.location.pathname.startsWith('/embed'))
  }
  return demo
}

// --- Wire types (mirror e2e/fixtures.ts) ------------------------------------

/** One op in a change frame, as the DO broadcasts and the batch POST carries.
 *  Mirrors `ChangeOp` in src/data/realtime.ts. */
type ApiChangeOp =
  | { op: 'insert'; value: Node }
  | { op: 'update'; value: Node }
  | { op: 'delete'; key: string }

// --- Fake sync socket -------------------------------------------------------
// Matches the exact surface Effect's `fromWebSocket` drives (readyState +
// add/removeEventListener + send + close, with `open`/`message`/`close`
// events) — the same shape the reconnect unit test's FakeWebSocket implements
// (src/data/realtime.test.ts). On `hello` it replies with a full snapshot; the
// backend pushes `change` frames to every open socket on each write.

const openSockets = new Set<DemoSyncSocket>()

class DemoSyncSocket {
  readyState = 0
  // Track {fn, once} rather than wrapping `once` in a new closure: Effect's
  // fromWebSocket registers `close`/`error` with {once:true} and later removes
  // them by their ORIGINAL ref (Socket.ts), so a wrapper would make
  // removeEventListener(originalFn) a silent no-op and leak listeners on a
  // torn-down socket. Storing the original fn keeps removal by-ref correct — a
  // faithful EventTarget, so a future reconnect/resync path stays safe.
  private listeners = new Map<
    string,
    Set<{ fn: (ev: unknown) => void; once: boolean }>
  >()

  constructor() {
    // Open on the next microtask so the caller has attached its `open` listener
    // (Effect adds it synchronously right after construction).
    queueMicrotask(() => {
      this.readyState = 1
      this.fire('open', {})
    })
  }

  addEventListener(
    type: string,
    fn: (ev: unknown) => void,
    opts?: { once?: boolean },
  ): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add({ fn, once: opts?.once ?? false })
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const set = this.listeners.get(type)
    if (!set) return
    for (const entry of set) {
      if (entry.fn === fn) {
        set.delete(entry)
        return
      }
    }
  }

  send(data: string): void {
    // The only frame the client sends is `hello`; answer it with the current
    // snapshot (a reconnect resumes from committed state, same as the DO).
    let msg: { type?: string } = {}
    try {
      msg = JSON.parse(data) as { type?: string }
    } catch {
      return
    }
    if (msg.type === 'hello') {
      openSockets.add(this)
      this.fire('message', {
        data: JSON.stringify({
          type: 'snapshot',
          seq,
          nodes: [...store.values()],
        }),
      })
    }
  }

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.readyState = 3
    openSockets.delete(this)
    this.fire('close', { code, reason: '' })
  }

  /** Push a decoded server frame to this socket. */
  deliver(frame: string): void {
    this.fire('message', { data: frame })
  }

  private fire(type: string, ev: unknown): void {
    const set = this.listeners.get(type)
    if (!set) return
    // Deleting `once` entries mid-iteration is safe (Set iteration tolerates
    // deletion of the current/visited entries).
    for (const entry of set) {
      if (entry.once) set.delete(entry)
      entry.fn(ev)
    }
  }
}

// --- In-memory store + broadcast (mirror e2e/fixtures.ts) -------------------

const store = new Map<string, Node>()
const kv = new Map<string, Map<string, unknown>>()
let seq = 0

/** Apply a committed change frame to every open sync socket, bumping seq. */
function broadcast(ops: ApiChangeOp[]): number {
  seq += 1
  const frame = JSON.stringify({ type: 'change', seq, ops })
  for (const sock of openSockets) sock.deliver(frame)
  return seq
}

function kvNs(collection: string): Map<string, unknown> {
  let m = kv.get(collection)
  if (!m) kv.set(collection, (m = new Map()))
  return m
}

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

// --- Request handlers (one per intercepted route) ---------------------------

async function handleNodes(method: string, body: () => Promise<unknown>): Promise<Response> {
  switch (method) {
    case 'GET':
      return json([...store.values()])
    case 'POST': {
      const b = (await body()) as { ops?: ApiChangeOp[]; nodes?: Node[] }
      // Atomic structural batch: apply every op, commit ONE frame, reply `{seq}`
      // (mirrors the DO's applyBatch).
      if (b.ops) {
        for (const op of b.ops) {
          if (op.op === 'delete') store.delete(op.key)
          else store.set(op.value.id, op.value)
        }
        return json({ seq: broadcast(b.ops) })
      }
      // Legacy upsert path (unused in demo — the seed loads via the snapshot).
      const ops: ApiChangeOp[] = (b.nodes ?? []).map((n) => ({ op: 'insert', value: n }))
      for (const n of b.nodes ?? []) store.set(n.id, n)
      if (ops.length) broadcast(ops)
      return json({ ok: true })
    }
    case 'PATCH': {
      const { updates } = (await body()) as {
        updates: { id: string; changes: Partial<Node> }[]
      }
      const ops: ApiChangeOp[] = []
      for (const u of updates ?? []) {
        const cur = store.get(u.id)
        if (cur) {
          const next = { ...cur, ...u.changes }
          store.set(u.id, next)
          ops.push({ op: 'update', value: next })
        }
      }
      if (ops.length) broadcast(ops)
      return json({ ok: true })
    }
    case 'DELETE': {
      const { ids } = (await body()) as { ids: string[] }
      const ops: ApiChangeOp[] = []
      for (const id of ids ?? []) {
        store.delete(id)
        ops.push({ op: 'delete', key: id })
      }
      if (ops.length) broadcast(ops)
      return json({ ok: true })
    }
    default:
      return new Response('{}', { status: 405 })
  }
}

async function handleKv(
  method: string,
  params: URLSearchParams,
  body: () => Promise<unknown>,
): Promise<Response> {
  const m = kvNs(params.get('collection') ?? '')
  switch (method) {
    case 'GET':
      return json([...m.values()])
    case 'POST': {
      // `?op=claim` mirrors the DO's atomic get-or-create (pre-existing wins).
      if (params.get('op') === 'claim') {
        const { key, value } = (await body()) as { key: string; value: unknown }
        if (!m.has(key)) m.set(key, value)
        return json({ value: m.get(key) })
      }
      const { rows } = (await body()) as { rows: { key: string; value: unknown }[] }
      for (const r of rows ?? []) m.set(r.key, r.value)
      return json({ ok: true })
    }
    case 'DELETE': {
      const { keys } = (await body()) as { keys: string[] }
      for (const k of keys ?? []) m.delete(k)
      return json({ ok: true })
    }
    default:
      return new Response('{}', { status: 405 })
  }
}

// --- Install ----------------------------------------------------------------

let installed = false

/**
 * Install the in-memory backend: seed the store, then patch `fetch` +
 * `WebSocket` so the editor's transport talks to memory instead of the network.
 * Idempotent. Call once, as early as possible (before the collection's first
 * subscribe) — __root.tsx does it at module load when `isDemoMode()`.
 */
export function installDemoBackend(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  // Note on the iframe scroll trap: the landing embeds this document CROSS-
  // ORIGIN (dotflowy.com → app.dotflowy.com), and browsers never chain a
  // cross-origin frame's overscroll to its embedder — wheel gestures only pass
  // through to the landing page when this document has NOTHING to scroll. Demo
  // mode therefore renders `html.demo-embed` (overflow:hidden, styles.css) —
  // from __root.tsx's JSX, NOT a classList.add here: React's first commit
  // replaces the whole class attribute, wiping anything added pre-render.

  // Seed the curated outline (delivered to the collection via the WS snapshot).
  for (const n of demoSeedNodes()) store.set(n.id, n)
  for (const [collection, rows] of Object.entries(demoSeedKv())) {
    const m = kvNs(collection)
    for (const r of rows) m.set(r.key, r.value)
  }

  const realFetch = window.fetch.bind(window)
  const RealWebSocket = window.WebSocket

  // --- fetch: intercept /api/*, pass everything else through ---
  window.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : 'GET')
    ).toUpperCase()
    const url = new URL(rawUrl, window.location.origin)
    const readBody = async (): Promise<unknown> => {
      const raw =
        init?.body != null
          ? typeof init.body === 'string'
            ? init.body
            : String(init.body)
          : input instanceof Request
            ? await input.clone().text()
            : ''
      return raw ? JSON.parse(raw) : {}
    }

    if (url.pathname === '/api/nodes') return handleNodes(method, readBody)
    if (url.pathname === '/api/kv') return handleKv(method, url.searchParams, readBody)
    // Link-paste title unfurl: no network in the sandbox — report "no title",
    // the graceful fallback (the url stays as its own label). See ADR 0016.
    if (url.pathname === '/api/unfurl') return json({ title: null })
    // AuthGate bypasses useSession in demo mode, but answer get-session with a
    // fixed anonymous session in case anything probes it.
    if (url.pathname === '/api/auth/get-session') {
      return json({ session: null, user: null })
    }
    // Deny-all for every OTHER server route (`/api/*`, `/mcp`): stub it, never
    // let it reach the network. This makes the security invariant — the sandbox
    // issues NO real, cookie-authenticated request — hold by construction, not
    // by which UI happens to be hidden. Anything unexpected gets a 404, not the
    // live Worker (e.g. a future component calling a Better Auth method).
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
      return new Response('{}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    // Non-`/api` requests (app assets, third-party) pass through untouched.
    return realFetch(input as RequestInfo, init)
  }) as typeof window.fetch

  // --- WebSocket: fake /api/sync, delegate everything else ---
  const PatchedWebSocket = function (
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ) {
    const href = typeof url === 'string' ? url : url.href
    if (href.includes('/api/sync')) return new DemoSyncSocket()
    return new RealWebSocket(url, protocols)
  } as unknown as typeof window.WebSocket
  // Preserve the ready-state constants some libraries read off the constructor.
  Object.assign(PatchedWebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  })
  window.WebSocket = PatchedWebSocket
}
