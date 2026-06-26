/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers'

/** A node as the client speaks it — booleans are real booleans. Mirrors the
 *  `Node` type in src/data/schema.ts. */
export interface Node {
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

/** A row as stored in the DO's SQLite — booleans are 0/1 integers, and there is
 *  no `owner` column: the DO instance *is* the owner scope. */
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

/** A side-collection row, as carried during the one-time D1 import. */
export interface KvRow {
  collection: string
  key: string
  value: unknown
}

type SqlVal = string | number | null

/** Columns a client may write, and which of them are stored as 0/1 booleans.
 *  The dynamic PATCH builds its SQL only from this allowlist, so it can't be
 *  injected. */
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

// --- Realtime sync protocol -------------------------------------------------
// The wire contract for /api/sync. MUST stay in lockstep with the client's copy
// in src/data/realtime.ts (the two live behind different tsconfigs, so the types
// are duplicated, not shared — same as Node/NodeRow above).

/** One node mutation in a change frame. Upserts carry the full node (insert for a
 *  new id, update for an existing one); deletes carry just the key. */
type ChangeOp =
  | { op: 'insert'; value: Node }
  | { op: 'update'; value: Node }
  | { op: 'delete'; key: string }

/** A committed batch of ops at a monotonic sequence number. */
interface ChangeFrame {
  seq: number
  ops: ChangeOp[]
}

/** DO -> client frames. `snapshot` = full state (initial connect or resync past
 *  the changelog window); `resume` = the gap since the client's cursor; `change`
 *  = a live mutation broadcast. */
type ServerMessage =
  | { type: 'snapshot'; seq: number; nodes: Node[] }
  | { type: 'resume'; seq: number; changes: ChangeFrame[] }
  | { type: 'change'; seq: number; ops: ChangeOp[] }

/** client -> DO. The only inbound message: the handshake, carrying the client's
 *  last-applied seq (null on a fresh/forced-resync connect). */
interface HelloMessage {
  type: 'hello'
  since: number | null
}

/** How many recent change frames the DO retains for reconnect replay. A client
 *  offline past this many edits falls back to a full snapshot. */
const CHANGELOG_KEEP = 1000

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

function toSqlValue(key: string, value: unknown): SqlVal {
  if (BOOL_COLUMNS.has(key)) return value ? 1 : 0
  return (value ?? null) as SqlVal
}

interface Env {
  // The DO uses only its own colocated SQLite storage; it needs no bindings yet.
}

/**
 * One Durable Object per user: the user's entire outline plus the plugin
 * side-collections (tag colors, daily index), in a single colocated SQLite.
 *
 * Replaces the per-owner D1 tables. Inside a per-user DO the `owner` column is
 * redundant (the DO is the scope), and the single thread serializes a user's
 * edits across all their devices — which removes the last-write-wins
 * reconciliation the D1 path needed.
 *
 * The HTTP contract the client speaks (/api/nodes, /api/kv) is unchanged: the
 * Worker translates each request into one RPC call below.
 */
export class UserOutlineDO extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    // Schema setup only — never hold blockConcurrencyWhile across external I/O.
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          id            TEXT PRIMARY KEY,
          parentId      TEXT,
          prevSiblingId TEXT,
          text          TEXT NOT NULL,
          isTask        INTEGER NOT NULL DEFAULT 0,
          completed     INTEGER NOT NULL DEFAULT 0,
          collapsed     INTEGER NOT NULL DEFAULT 0,
          bookmarkedAt  INTEGER,
          createdAt     INTEGER NOT NULL,
          updatedAt     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parentId);
        CREATE TABLE IF NOT EXISTS kv (
          collection TEXT NOT NULL,
          key        TEXT NOT NULL,
          value      TEXT NOT NULL,
          updatedAt  INTEGER NOT NULL,
          PRIMARY KEY (collection, key)
        );
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS changelog (
          seq INTEGER PRIMARY KEY,
          ops TEXT NOT NULL
        );
      `)
    })
  }

  // --- nodes -----------------------------------------------------------------

  getNodes(): Node[] {
    const rows = this.sql
      .exec(
        'SELECT id, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, createdAt, updatedAt FROM nodes',
      )
      .toArray() as unknown as NodeRow[]
    return rows.map(rowToNode)
  }

  upsertNodes(nodes: Node[]): void {
    const ops: ChangeOp[] = []
    for (const n of nodes) {
      // Insert vs update so the broadcast carries the right ChangeMessage type
      // (the client's sync layer distinguishes them). One indexed point-lookup.
      const existed =
        this.sql.exec('SELECT 1 FROM nodes WHERE id = ?', n.id).toArray().length > 0
      this.sql.exec(
        `INSERT INTO nodes (id, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           parentId=excluded.parentId, prevSiblingId=excluded.prevSiblingId, text=excluded.text,
           isTask=excluded.isTask, completed=excluded.completed, collapsed=excluded.collapsed,
           bookmarkedAt=excluded.bookmarkedAt, updatedAt=excluded.updatedAt`,
        n.id,
        n.parentId,
        n.prevSiblingId,
        n.text,
        n.isTask ? 1 : 0,
        n.completed ? 1 : 0,
        n.collapsed ? 1 : 0,
        n.bookmarkedAt,
        n.createdAt,
        n.updatedAt,
      )
      ops.push({ op: existed ? 'update' : 'insert', value: n })
    }
    this.commitChange(ops)
  }

  patchNodes(updates: { id: string; changes: Record<string, unknown> }[]): void {
    const ops: ChangeOp[] = []
    for (const u of updates) {
      const sets: string[] = []
      const vals: SqlVal[] = []
      for (const [k, v] of Object.entries(u.changes)) {
        if (!WRITABLE_COLUMNS.has(k)) continue
        sets.push(`${k} = ?`)
        vals.push(toSqlValue(k, v))
      }
      if (!sets.length) continue
      vals.push(u.id)
      this.sql.exec(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`, ...vals)
      // Broadcast the full post-patch row (canonical booleans, every field) so a
      // remote client applies an unambiguous update regardless of rowUpdateMode.
      const row = this.sql
        .exec(
          'SELECT id, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, createdAt, updatedAt FROM nodes WHERE id = ?',
          u.id,
        )
        .toArray()[0] as unknown as NodeRow | undefined
      if (row) ops.push({ op: 'update', value: rowToNode(row) })
    }
    this.commitChange(ops)
  }

  deleteNodes(ids: string[]): void {
    const ops: ChangeOp[] = []
    for (const id of ids) {
      this.sql.exec('DELETE FROM nodes WHERE id = ?', id)
      ops.push({ op: 'delete', key: id })
    }
    this.commitChange(ops)
  }

  // --- realtime sync (WebSocket Hibernation) ---------------------------------

  /** The latest committed sequence number (0 if nothing has changed yet). */
  private currentSeq(): number {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seq'")
      .toArray()[0]
    return row ? Number(row.value) : 0
  }

  /** Allocate the next monotonic sequence number and persist it. */
  private bumpSeq(): number {
    const next = this.currentSeq() + 1
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(next),
    )
    return next
  }

  /**
   * Record a batch of ops at a new seq, prune the changelog to its window, and
   * broadcast the change to every connected device. Called at the end of each
   * node mutation. A no-op for an empty batch (e.g. a patch that touched no
   * writable columns), so the seq only advances on real changes.
   *
   * Broadcasting is free (outgoing WS); the send runs inside the DO window the
   * triggering write already opened, so it adds negligible billed duration.
   */
  private commitChange(ops: ChangeOp[]): void {
    if (!ops.length) return
    const seq = this.bumpSeq()
    this.sql.exec('INSERT INTO changelog (seq, ops) VALUES (?, ?)', seq, JSON.stringify(ops))
    this.sql.exec('DELETE FROM changelog WHERE seq <= ?', seq - CHANGELOG_KEEP)
    const data = JSON.stringify({ type: 'change', seq, ops } satisfies ServerMessage)
    for (const ws of this.ctx.getWebSockets()) {
      // A socket can race a close; the runtime will fire webSocketClose for it.
      try {
        ws.send(data)
      } catch {
        // already gone
      }
    }
  }

  /**
   * Accept a WebSocket upgrade with the Hibernation API. The runtime owns the
   * socket set (survives eviction), so idle connections cost nothing — the
   * budget rule. We never call the legacy `ws.accept()`. The client drives the
   * handshake by sending a `hello` (see webSocketMessage); we just return 101.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 })
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** The only inbound message is the `hello` handshake; reply with the snapshot
   *  or the gap since the client's cursor. Anything else is ignored. */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const hello = this.parseHello(raw)
    if (!hello) return
    ws.send(JSON.stringify(this.initialFrame(hello.since)))
  }

  /** Complete the closing handshake (CF best practice for Hibernation). */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason)
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error')
    } catch {
      // already closed
    }
  }

  private parseHello(raw: string | ArrayBuffer): HelloMessage | null {
    if (typeof raw !== 'string') return null
    try {
      const m = JSON.parse(raw) as HelloMessage
      return m && m.type === 'hello' ? m : null
    } catch {
      return null
    }
  }

  /**
   * The frame to send right after a `hello`. If the client's `since` cursor is
   * still inside the retained changelog window, send just the gap (`resume`);
   * otherwise send the whole outline (`snapshot`). A null cursor always takes
   * the snapshot path.
   */
  private initialFrame(since: number | null): ServerMessage {
    const seq = this.currentSeq()
    if (since !== null && since <= seq) {
      const oldest =
        this.sql
          .exec<{ m: number | null }>('SELECT MIN(seq) AS m FROM changelog')
          .toArray()[0]?.m ?? null
      // Resumable iff the client is already current (nothing to send) or the
      // next frame it needs (since + 1) is still retained.
      const canResume = since === seq || (oldest !== null && since + 1 >= oldest)
      if (canResume) {
        const rows = this.sql
          .exec<{ seq: number; ops: string }>(
            'SELECT seq, ops FROM changelog WHERE seq > ? ORDER BY seq',
            since,
          )
          .toArray()
        return {
          type: 'resume',
          seq,
          changes: rows.map((r) => ({ seq: r.seq, ops: JSON.parse(r.ops) as ChangeOp[] })),
        }
      }
    }
    return { type: 'snapshot', seq, nodes: this.getNodes() }
  }

  // --- kv side-collections ---------------------------------------------------

  getKv(collection: string): unknown[] {
    return this.sql
      .exec<{ value: string }>('SELECT value FROM kv WHERE collection = ?', collection)
      .toArray()
      .map((r) => JSON.parse(r.value))
  }

  upsertKv(collection: string, rows: { key: string; value: unknown }[]): void {
    const ts = Date.now()
    for (const r of rows) {
      this.sql.exec(
        `INSERT INTO kv (collection, key, value, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(collection, key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
        collection,
        r.key,
        JSON.stringify(r.value),
        ts,
      )
    }
  }

  deleteKv(collection: string, keys: string[]): void {
    for (const k of keys)
      this.sql.exec('DELETE FROM kv WHERE collection = ? AND key = ?', collection, k)
  }

  /**
   * Atomic get-or-create on a kv key. Insert `value` only if (collection, key)
   * is absent, then return the AUTHORITATIVE value — the pre-existing one wins.
   * Atomic because the DO is single-threaded across all the user's devices, so
   * two devices racing to create the same key (e.g. today's daily note) both
   * resolve to the one winner instead of each minting a duplicate.
   *
   * Generic on purpose: the DO never learns what "daily" is, it just gains an
   * atomic op on its existing kv table, reusable by any future side-collection.
   */
  getOrCreateKv(collection: string, key: string, value: unknown): unknown {
    this.sql.exec(
      `INSERT INTO kv (collection, key, value, updatedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(collection, key) DO NOTHING`,
      collection,
      key,
      JSON.stringify(value),
      Date.now(),
    )
    const row = this.sql
      .exec<{ value: string }>(
        'SELECT value FROM kv WHERE collection = ? AND key = ?',
        collection,
        key,
      )
      .toArray()[0]
    return row ? JSON.parse(row.value) : value
  }

  // --- one-time import from the legacy D1 tables -----------------------------

  isSeeded(): boolean {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seeded'")
      .toArray()[0]
    return row?.value === '1'
  }

  /** Idempotently load the user's existing rows (read from D1 by the Worker,
   *  which owns the D1 binding) into this DO, then mark it seeded so it never
   *  re-imports. Non-destructive: D1 is left intact. */
  seed(data: { nodes: Node[]; kv: KvRow[] }): void {
    if (this.isSeeded()) return
    this.upsertNodes(data.nodes)
    for (const collection of new Set(data.kv.map((r) => r.collection))) {
      this.upsertKv(
        collection,
        data.kv
          .filter((r) => r.collection === collection)
          .map((r) => ({ key: r.key, value: r.value })),
      )
    }
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
    )
  }
}
