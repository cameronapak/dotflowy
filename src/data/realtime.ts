import * as errore from 'errore'
import type { Node } from './schema'

/**
 * The realtime sync transport: one WebSocket per tab to the per-user Durable
 * Object (`/api/sync`), carrying outline changes live. This module owns only the
 * socket — connect, the `hello` handshake, frame decoding, reconnect/backoff,
 * and forced resync. Applying frames to the collection lives in collection.ts,
 * which holds the TanStack DB sync primitives.
 *
 * Budget: idle hibernated sockets cost nothing and outgoing broadcasts are free,
 * so this is ~$0 over the base plan (see docs/realtime-push-plan.md). The cost
 * trap is the legacy `ws.accept()` on the server, which we never use.
 *
 * Browser-only: collection.ts guards the `/` prerender, so this never runs
 * server-side (opening a WebSocket there would throw).
 */

// --- Wire protocol ----------------------------------------------------------
// MUST stay in lockstep with worker/outline-do.ts (duplicated, not shared — the
// two live behind different tsconfigs, same as the Node type).

/** One node mutation in a change frame. */
export type ChangeOp =
  | { op: 'insert'; value: Node }
  | { op: 'update'; value: Node }
  | { op: 'delete'; key: string }

/** A committed batch of ops at a monotonic sequence number. */
export interface ChangeFrame {
  seq: number
  ops: ChangeOp[]
}

/** DO -> client frames. `snapshot` = full state; `resume` = the gap since the
 *  client's cursor; `change` = a live mutation. */
export type ServerMessage =
  | { type: 'snapshot'; seq: number; nodes: Node[] }
  | { type: 'resume'; seq: number; changes: ChangeFrame[] }
  | { type: 'change'; seq: number; ops: ChangeOp[] }

export interface SyncSocketHandlers {
  /** A decoded server frame arrived. */
  onMessage: (msg: ServerMessage) => void
  /** The current resume cursor (last applied seq), read at every (re)connect so
   *  the server replies with only what this client missed. Null = full
   *  snapshot. */
  getCursor: () => number | null
  /** A connection went down BEFORE this client ever synced any data (offline /
   *  server down / auth lost). The collection uses this to mark ready + record
   *  the failure, so first-run bootstrap won't seed over a real-but-unreachable
   *  outline. Harmless to fire more than once. */
  onInitialError: (err: Error) => void
}

export interface SyncSocket {
  /** Force a full resync: the next connect ignores the cursor, so the server
   *  replies with a fresh snapshot the collection truncates onto. */
  resync: () => void
  /** Stop reconnecting and close the socket. */
  close: () => void
}

/** Cap the exponential backoff between reconnect attempts. */
const MAX_BACKOFF_MS = 30_000
/** If the `hello` reply never arrives, treat the socket as dead and retry. */
const HELLO_TIMEOUT_MS = 8_000

function syncUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/sync`
}

function decodeFrame(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null
  const parsed = errore.try({
    try: () => JSON.parse(data) as ServerMessage,
    catch: (e) => new Error('malformed sync frame', { cause: e }),
  })
  if (parsed instanceof Error) {
    console.warn('realtime:', parsed.message)
    return null
  }
  return parsed
}

/**
 * Open the sync socket and keep it alive. Returns immediately; frames arrive via
 * `handlers.onMessage`. Reconnects with exponential backoff on any drop. The
 * Better Auth session cookie rides the same-origin handshake automatically.
 */
export function connectSyncSocket(handlers: SyncSocketHandlers): SyncSocket {
  let ws: WebSocket | null = null
  let closed = false
  let everDelivered = false
  let attempt = 0
  let forceSnapshot = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return
    const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt)
    const delay = backoff + Math.floor(Math.random() * 250)
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      open()
    }, delay)
  }

  function open(): void {
    if (closed) return
    const socket = new WebSocket(syncUrl())
    ws = socket
    let downHandled = false
    let helloTimer: ReturnType<typeof setTimeout> | null = null

    const clearHelloTimer = () => {
      if (helloTimer) {
        clearTimeout(helloTimer)
        helloTimer = null
      }
    }

    socket.onopen = () => {
      const since = forceSnapshot ? null : handlers.getCursor()
      forceSnapshot = false
      socket.send(JSON.stringify({ type: 'hello', since }))
      // No reply to `hello` -> the connection is dead weight; drop it and retry.
      helloTimer = setTimeout(() => {
        if (ws === socket) socket.close()
      }, HELLO_TIMEOUT_MS)
    }

    socket.onmessage = (ev) => {
      const msg = decodeFrame(ev.data)
      if (!msg) return
      clearHelloTimer()
      everDelivered = true
      attempt = 0
      handlers.onMessage(msg)
    }

    const onDown = () => {
      if (downHandled) return
      downHandled = true
      clearHelloTimer()
      if (ws === socket) ws = null
      if (closed) return
      // Never synced yet -> surface the failure so bootstrap doesn't seed over a
      // just-unreachable outline. After the first sync, a drop is routine.
      if (!everDelivered) {
        handlers.onInitialError(new Error('sync socket closed before initial data'))
      }
      scheduleReconnect()
    }
    socket.onclose = onDown
    socket.onerror = onDown
  }

  function resync(): void {
    if (closed) return
    forceSnapshot = true
    if (ws) ws.close()
    else if (!reconnectTimer) open()
  }

  function close(): void {
    closed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
      ws = null
    }
  }

  open()
  return { resync, close }
}
