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
    for (const n of nodes) {
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
    }
  }

  patchNodes(updates: { id: string; changes: Record<string, unknown> }[]): void {
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
    }
  }

  deleteNodes(ids: string[]): void {
    for (const id of ids) this.sql.exec('DELETE FROM nodes WHERE id = ?', id)
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
