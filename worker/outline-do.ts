/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

import type {
  ChangeFrame,
  ChangeOp,
  Node,
  ServerMessage,
} from "../src/data/wire-schema";
import type { RestorePoint } from "./restore";

import { planChangeFrames } from "./changelog";
import { batchExceedsNodeLimit, countNetGrowth } from "./plan";
import { APP_VERSION } from "./version";

// The wire types (`Node`, `ChangeOp`, `ChangeFrame`, `ServerMessage`) come from
// the shared wire module — the one leaf the client and the Worker both derive
// from, so the DO can't drift from what the client sends. Re-export the two the
// existing importers (worker/index.ts) resolve from here.
export type { ChangeOp, Node };

/** A row as stored in the DO's SQLite — booleans are 0/1 integers, and there is
 *  no `owner` column: the DO instance *is* the owner scope. */
interface NodeRow {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: number;
  completed: number;
  collapsed: number;
  bookmarkedAt: number | null;
  mirrorOf: string | null;
  createdAt: number;
  updatedAt: number;
  origin: string | null;
  kind: string | null;
}

/** A side-collection row, as carried during the one-time D1 import. */
export interface KvRow {
  collection: string;
  key: string;
  value: unknown;
}

type SqlVal = string | number | null;

/** Columns a client may write, and which of them are stored as 0/1 booleans.
 *  The dynamic PATCH builds its SQL only from this allowlist, so it can't be
 *  injected. */
const BOOL_COLUMNS = new Set(["isTask", "completed", "collapsed"]);
const WRITABLE_COLUMNS = new Set([
  "parentId",
  "prevSiblingId",
  "text",
  "isTask",
  "completed",
  "collapsed",
  "bookmarkedAt",
  "mirrorOf",
  "createdAt",
  "updatedAt",
  // `setKind` is a field edit (a PATCH), so the column must be writable here.
  "kind",
]);

// --- Realtime sync protocol -------------------------------------------------
// `ChangeFrame` (the unit recordChange returns to broadcastChange — the SQL
// commit and the WS broadcast are two steps so the broadcast only fires
// post-commit) and `ServerMessage` (the DO→client frames) are imported from the
// shared wire module above, so the DO can't drift from the client's decoder.
// `HelloMessage` is worker-inbound-only, so it stays local.

/** client -> DO. The only inbound message: the handshake, carrying the client's
 *  last-applied seq (null on a fresh/forced-resync connect). */
interface HelloMessage {
  type: "hello";
  since: number | null;
}

/** How many recent change frames the DO retains for reconnect replay. A client
 *  offline past this many edits falls back to a full snapshot. */
const CHANGELOG_KEEP = 1000;

/** Delay before `ctx.abort()` fires the armed point-in-time restore. The restore
 *  is already persisted by `onNextSessionRestoreBookmark`, so this only has to
 *  outlast the RPC response leaving the DO — a botched abort still applies on the
 *  next natural restart. See `restoreToTime`. */
const RESTORE_ABORT_DELAY_MS = 1000;

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
    mirrorOf: r.mirrorOf,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    origin: r.origin,
    // The column is a plain TEXT, so narrow it back to the literal union: an
    // unrecognized value reads as a bullet rather than escaping into a frame the
    // client's `ServerMessageSchema` would then reject (ADR 0045 / ADR 0014).
    kind: r.kind === "paragraph" ? "paragraph" : null,
  };
}

function toSqlValue(key: string, value: unknown): SqlVal {
  if (BOOL_COLUMNS.has(key)) return value ? 1 : 0;
  return (value ?? null) as SqlVal;
}

interface Env {
  // The DO uses only its own colocated SQLite storage; it needs no bindings.
  /** Public Sentry DSN (wrangler.jsonc var), read by the Sentry DO wrapper in
   *  worker/index.ts (#227). Unset => error monitoring is dormant. */
  SENTRY_DSN?: string;
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
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Schema setup only — never hold blockConcurrencyWhile across external I/O.
    // Runs before any request is served, so no reader ever sees a half-built
    // schema (e.g. getNodes reading a missing `mirrorOf` column).
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  // --- schema migration ------------------------------------------------------
  // Ordered, versioned migrator (ADR 0023). `meta.schema_version` records the
  // last-applied step; on construct we run every step `> current`, each inside a
  // `transactionSync`, and bump the version. This replaces the constructor's
  // ad-hoc `CREATE TABLE IF NOT EXISTS` block AND the hand-rolled
  // `PRAGMA table_info` / `ALTER TABLE mirrorOf` dance (ADR 0022) — schema
  // evolution is now append-only: a change is a new MIGRATIONS entry.

  /** Ordered schema steps. v1 is the IDEMPOTENT BASELINE: a fresh DO and a
   *  pre-versioning deployed DO both read version 0 (absent `schema_version`),
   *  so v1 must be safe on both — it is today's `CREATE TABLE IF NOT EXISTS` set
   *  plus the guarded `mirrorOf` add. From v2 onward every step is guaranteed to
   *  run exactly once, so no future step needs a `PRAGMA`/`IF NOT EXISTS` guard.
   *  (This idempotent-baseline / exactly-once-tail split is the load-bearing
   *  invariant — see ADR 0023.) */
  private static readonly MIGRATIONS: ReadonlyArray<{
    version: number;
    up: (sql: SqlStorage) => void;
  }> = [
    {
      version: 1,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS nodes (
            id            TEXT PRIMARY KEY,
            parentId      TEXT,
            prevSiblingId TEXT,
            text          TEXT NOT NULL,
            isTask        INTEGER NOT NULL DEFAULT 0,
            completed     INTEGER NOT NULL DEFAULT 0,
            collapsed     INTEGER NOT NULL DEFAULT 0,
            bookmarkedAt  INTEGER,
            mirrorOf      TEXT,
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
        `);
        // Pre-mirror `nodes` tables (a deployed DO) were created without
        // `mirrorOf`, and `CREATE TABLE IF NOT EXISTS` above no-ops for them.
        // Add the column once, guarded by a column-existence check since SQLite
        // has no `ADD COLUMN IF NOT EXISTS`. A fresh DO already has it from the
        // CREATE, so this skips. The guard lives here (not in a later step)
        // because v1 is the one migration that can meet an already-populated DB.
        const hasMirrorOf = (
          sql.exec(`PRAGMA table_info(nodes)`).toArray() as Array<{
            name: string;
          }>
        ).some((c) => c.name === "mirrorOf");
        if (!hasMirrorOf)
          sql.exec(`ALTER TABLE nodes ADD COLUMN mirrorOf TEXT`);
      },
    },
    {
      // Node provenance (write-once): who created a node. NULL = human (every
      // pre-existing row backfills to NULL, the correct "made by the user"
      // default); a harness name = an agent via MCP. Exactly-once tail step, so
      // no existence guard needed (ADR 0023). ADD COLUMN defaults existing rows
      // to NULL, which is exactly the semantics we want.
      version: 2,
      up: (sql) => {
        sql.exec(`ALTER TABLE nodes ADD COLUMN origin TEXT`);
      },
    },
    {
      // Node kind (ADR 0045): NULL = a bullet or a task (per `isTask`), which is
      // exactly what every pre-existing row is, so ADD COLUMN's NULL default is
      // the correct backfill. Exactly-once tail step, no existence guard.
      version: 3,
      up: (sql) => {
        sql.exec(`ALTER TABLE nodes ADD COLUMN kind TEXT`);
      },
    },
  ];

  /** Run every migration newer than the recorded schema version, each atomically
   *  (its DDL + the version bump commit together or roll back together). */
  private migrate(): void {
    // Bootstrap: `meta` must exist before we can read the version. Idempotent —
    // a fresh DO has no tables; a deployed DO already has `meta` populated.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    const current = this.schemaVersion();
    for (const step of UserOutlineDO.MIGRATIONS) {
      if (step.version <= current) continue;
      this.ctx.storage.transactionSync(() => {
        step.up(this.sql);
        this.sql.exec(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          String(step.version),
        );
      });
    }
  }

  /** The last-applied schema version (0 if never migrated / pre-versioning).
   *  Same meta single-column read shape as `currentSeq`. */
  private schemaVersion(): number {
    const row = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      )
      .toArray()[0];
    return row ? Number(row.value) : 0;
  }

  /** Run a read query and return its rows as `T[]`. The one seam for the
   *  wide-row reads that need the runtime-shape cast — it replaces the inline
   *  `as unknown as NodeRow[]` at the `nodes` SELECT sites (`getNodes`,
   *  `patchNodes`); ADR 0023. The narrow single-column reads elsewhere
   *  (`currentSeq`, `getKv`, `initialFrame`, …) keep using the type-checked
   *  `exec<{…}>()` overload, which needs no cast. */
  private readRows<T>(query: string, ...params: SqlVal[]): T[] {
    return this.sql.exec(query, ...params).toArray() as unknown as T[];
  }

  // --- nodes -----------------------------------------------------------------

  getNodes(): Node[] {
    return this.readRows<NodeRow>(
      "SELECT id, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, mirrorOf, createdAt, updatedAt, origin, kind FROM nodes",
    ).map(rowToNode);
  }

  /** Upsert one node into SQLite and return the change op describing it (insert
   *  for a new id, update for an existing one). Shared by upsertNodes (one frame
   *  per call) and applyBatch (many ops, one frame). One indexed point-lookup
   *  picks insert vs update so the broadcast carries the right ChangeMessage
   *  type (the client's sync layer distinguishes them). */
  private putNode(n: Node): ChangeOp {
    const existed =
      this.sql.exec("SELECT 1 FROM nodes WHERE id = ?", n.id).toArray().length >
      0;
    // `origin` is WRITE-ONCE: it's in the INSERT column list but deliberately
    // absent from the ON CONFLICT SET, so a later upsert (a move/reparent that
    // re-puts the full node) can never flip a node's provenance. Existing rows
    // keep whatever they were born with; legacy rows stay NULL (human).
    this.sql.exec(
      `INSERT INTO nodes (id, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, mirrorOf, createdAt, updatedAt, origin, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         parentId=excluded.parentId, prevSiblingId=excluded.prevSiblingId, text=excluded.text,
         isTask=excluded.isTask, completed=excluded.completed, collapsed=excluded.collapsed,
         bookmarkedAt=excluded.bookmarkedAt, mirrorOf=excluded.mirrorOf, updatedAt=excluded.updatedAt,
         kind=excluded.kind`,
      n.id,
      n.parentId,
      n.prevSiblingId,
      n.text,
      n.isTask ? 1 : 0,
      n.completed ? 1 : 0,
      n.collapsed ? 1 : 0,
      n.bookmarkedAt,
      n.mirrorOf,
      n.createdAt,
      n.updatedAt,
      n.origin,
      n.kind,
    );
    return { op: existed ? "update" : "insert", value: n };
  }

  /** Delete one node from SQLite and return its delete op. Shared by deleteNodes
   *  and applyBatch. */
  private deleteNodeRow(id: string): ChangeOp {
    this.sql.exec("DELETE FROM nodes WHERE id = ?", id);
    return { op: "delete", key: id };
  }

  upsertNodes(nodes: readonly Node[]): void {
    this.broadcastChange(
      this.ctx.storage.transactionSync(() =>
        this.recordChange(nodes.map((n) => this.putNode(n))),
      ),
    );
  }

  // --- free-tier node ceiling (#170) -----------------------------------------
  // The DO enforces a numeric cap it is TOLD by its trusted Worker; it never
  // learns what a "plan" is (the Worker resolves that from D1 via getPlan and
  // passes the limit). `null` = unlimited (paid). The check runs INSIDE the
  // write transaction and, on reject, returns without applying — so the commit
  // is a clean no-op and no frame is broadcast (the batch simply didn't happen).
  // Only genuine growth past the ceiling is refused; see batchExceedsNodeLimit.

  /** Total live node rows (the cap counts every node — bullets, tasks, mirrors,
   *  containers). A single indexed COUNT: sub-millisecond even at 17k rows, so no
   *  maintained counter is worth its drift/backfill risk at a 10,000-node cap. */
  private nodeCount(): number {
    const row = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM nodes")
      .toArray()[0];
    return row?.n ?? 0;
  }

  private nodeExists(id: string): boolean {
    return (
      this.sql.exec("SELECT 1 FROM nodes WHERE id = ?", id).toArray().length > 0
    );
  }

  /**
   * `applyBatch`, gated by a free-tier node ceiling. Returns the committed seq,
   * or `null` when the batch would grow the outline past `limit` (the Worker maps
   * that to a 403 the client surfaces). A `null` limit skips the check entirely
   * (paid users take the same path as ungated applyBatch, one extra no-op branch).
   *
   * Growth is counted by `countNetGrowth` via read-only existence probes BEFORE
   * any write: for each DISTINCT id its LAST op wins, so a delete of an absent
   * row, an upsert of an existing id, AND a delete+reinsert of the same id all
   * contribute zero — only ids that end the batch newly-present count as inserts,
   * only ids that end newly-absent as deletes. The decision
   * (batchExceedsNodeLimit) is pure and unit-tested; here we just feed it the two
   * net counts plus the SQLite total. Rejecting writes nothing, so the client's
   * optimistic overlay rolls back cleanly.
   */
  applyBatchGated(
    ops: readonly ChangeOp[],
    limit: number | null,
  ): number | null {
    const frames = this.ctx.storage.transactionSync(() => {
      if (limit !== null) {
        const { inserts, deletes } = countNetGrowth(ops, (id) =>
          this.nodeExists(id),
        );
        if (batchExceedsNodeLimit(this.nodeCount(), inserts, deletes, limit))
          return null;
      }
      return this.recordChange(
        ops.map((op) =>
          op.op === "delete"
            ? this.deleteNodeRow(op.key)
            : this.putNode(op.value),
        ),
      );
    });
    if (frames === null) return null;
    return this.broadcastChange(frames);
  }

  /** `upsertNodes`, gated by the same ceiling (the legacy first-run/seed create
   *  path — a raw POST could otherwise bypass the cap the batch path enforces).
   *  Every node is an upsert, so growth = ids not already present; returns false
   *  when applying would exceed the cap (nothing written), true otherwise. */
  upsertNodesGated(nodes: readonly Node[], limit: number | null): boolean {
    const frames = this.ctx.storage.transactionSync(() => {
      if (limit !== null) {
        const newIds = new Set<string>();
        for (const n of nodes) if (!this.nodeExists(n.id)) newIds.add(n.id);
        if (batchExceedsNodeLimit(this.nodeCount(), newIds.size, 0, limit))
          return null;
      }
      return this.recordChange(nodes.map((n) => this.putNode(n)));
    });
    if (frames === null) return false;
    this.broadcastChange(frames);
    return true;
  }

  /**
   * Apply a heterogeneous batch of ops (insert/update/delete) as ONE atomic
   * commit: every SQL write — the ops AND the seq bumps / changelog rows — runs
   * inside a single `transactionSync`, so a throw on any op rolls the whole batch
   * back; only on full commit does `broadcastChange` emit the frames. A batch
   * over 500 ops commits as multiple consecutive-seq changelog rows/frames
   * (chunked `recordChange`, issue #124 — SQLite's 2 MB row cap), but the
   * commit itself is still all-or-nothing. This is the structural write path —
   * an insert-and-repoint (or delete-and-repoint) lands all-or-nothing, so no
   * reader ever observes a half-relinked sibling chain, even if an op faults
   * mid-loop. Returns the FINAL seq the batch committed at (the current seq if
   * the batch was empty), which the originating client waits for before
   * dropping its optimistic overlay (so a fast follow-up edit can't read a
   * reverted state). See docs/adr/0009 and docs/adr/0014.
   *
   * Insert/update ops carry the full post-mutation node (an upsert); the DO
   * recomputes insert-vs-update from row existence, so the client's op type is
   * advisory. Apply order follows the array, but within one frame the ops are
   * absolute (keyed by id), so the final state is order-independent.
   */
  applyBatch(ops: readonly ChangeOp[]): number {
    return this.broadcastChange(
      this.ctx.storage.transactionSync(() => {
        const out: ChangeOp[] = [];
        for (const op of ops) {
          out.push(
            op.op === "delete"
              ? this.deleteNodeRow(op.key)
              : this.putNode(op.value),
          );
        }
        return this.recordChange(out);
      }),
    );
  }

  patchNodes(
    updates: readonly { id: string; changes: Record<string, unknown> }[],
  ): void {
    this.broadcastChange(
      this.ctx.storage.transactionSync(() => {
        const ops: ChangeOp[] = [];
        for (const u of updates) {
          const sets: string[] = [];
          const vals: SqlVal[] = [];
          for (const [k, v] of Object.entries(u.changes)) {
            if (!WRITABLE_COLUMNS.has(k)) continue;
            sets.push(`${k} = ?`);
            vals.push(toSqlValue(k, v));
          }
          if (!sets.length) continue;
          vals.push(u.id);
          this.sql.exec(
            `UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`,
            ...vals,
          );
          // Broadcast the full post-patch row (canonical booleans, every field) so
          // a remote client applies an unambiguous update regardless of rowUpdateMode.
          const row = this.readRows<NodeRow>(
            "SELECT id, parentId, prevSiblingId, text, isTask, completed, collapsed, bookmarkedAt, mirrorOf, createdAt, updatedAt, origin, kind FROM nodes WHERE id = ?",
            u.id,
          )[0] as NodeRow | undefined;
          if (row) ops.push({ op: "update", value: rowToNode(row) });
        }
        return this.recordChange(ops);
      }),
    );
  }

  deleteNodes(ids: readonly string[]): void {
    this.broadcastChange(
      this.ctx.storage.transactionSync(() =>
        this.recordChange(ids.map((id) => this.deleteNodeRow(id))),
      ),
    );
  }

  // --- realtime sync (WebSocket Hibernation) ---------------------------------

  /** The latest committed sequence number (0 if nothing has changed yet). */
  private currentSeq(): number {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seq'")
      .toArray()[0];
    return row ? Number(row.value) : 0;
  }

  /** Persist a committed sequence number (the meta cursor `currentSeq` reads). */
  private setSeq(seq: number): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(seq),
    );
  }

  /**
   * Record a batch of ops as ≤500-op changelog rows and prune the changelog to
   * its window — the SQL half of a commit, run INSIDE the caller's
   * `transactionSync` alongside the row writes so the seq bump and every
   * changelog row roll back with the ops on any fault. A large batch (an OPML
   * import can be thousands of ops, megabytes of JSON) is CHUNKED via
   * `planChangeFrames` (worker/changelog.ts) into consecutive-seq rows so no
   * single row nears SQLite's 2 MB cap; op order is preserved across chunk
   * boundaries, so every frame prefix stays chain-valid for a live remote
   * client. A no-op for an empty batch (e.g. a patch that touched no writable
   * columns), so the seq only advances on real changes. Returns the frames
   * (committed seqs + ops) for `broadcastChange` to emit, in order, once the
   * transaction has committed.
   */
  private recordChange(ops: ChangeOp[]): ChangeFrame[] {
    const frames = planChangeFrames(ops, this.currentSeq());
    if (!frames.length) return frames;
    for (const f of frames) {
      this.sql.exec(
        "INSERT INTO changelog (seq, ops) VALUES (?, ?)",
        f.seq,
        JSON.stringify(f.ops),
      );
    }
    const finalSeq = frames[frames.length - 1].seq;
    this.setSeq(finalSeq);
    this.sql.exec(
      "DELETE FROM changelog WHERE seq <= ?",
      finalSeq - CHANGELOG_KEEP,
    );
    return frames;
  }

  /**
   * Broadcast the committed frames to every connected device, in seq order, and
   * return the FINAL seq (what the originating client `waitForSeq`s before
   * dropping its optimistic overlay). Runs AFTER `recordChange`'s
   * `transactionSync` has committed — events only go out for state that durably
   * landed, never for a batch that rolled back. A no-op for an empty commit
   * (nothing changed, so nobody is notified; returns the current seq).
   *
   * Broadcasting is free (outgoing WS); the send runs inside the DO window the
   * triggering write already opened, so it adds negligible billed duration.
   */
  private broadcastChange(frames: readonly ChangeFrame[]): number {
    if (!frames.length) return this.currentSeq();
    const sockets = this.ctx.getWebSockets();
    for (const frame of frames) {
      const data = JSON.stringify({
        type: "change",
        seq: frame.seq,
        ops: frame.ops,
      } satisfies ServerMessage);
      for (const ws of sockets) {
        // A socket can race a close; the runtime will fire webSocketClose for it.
        try {
          ws.send(data);
        } catch {
          // already gone
        }
      }
    }
    return frames[frames.length - 1].seq;
  }

  /**
   * Accept a WebSocket upgrade with the Hibernation API. The runtime owns the
   * socket set (survives eviction), so idle connections cost nothing — the
   * budget rule. We never call the legacy `ws.accept()`. The client drives the
   * handshake by sending a `hello` (see webSocketMessage); we just return 101.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The only inbound message is the `hello` handshake; reply with the snapshot
   *  or the gap since the client's cursor. Anything else is ignored. */
  async webSocketMessage(
    ws: WebSocket,
    raw: string | ArrayBuffer,
  ): Promise<void> {
    const hello = this.parseHello(raw);
    if (!hello) return;
    ws.send(JSON.stringify(this.initialFrame(hello.since)));
  }

  /** Complete the closing handshake (CF best practice for Hibernation). */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      // already closed
    }
  }

  private parseHello(raw: string | ArrayBuffer): HelloMessage | null {
    if (typeof raw !== "string") return null;
    try {
      const m = JSON.parse(raw) as HelloMessage;
      return m && m.type === "hello" ? m : null;
    } catch {
      return null;
    }
  }

  /**
   * The frame to send right after a `hello`. If the client's `since` cursor is
   * still inside the retained changelog window, send just the gap (`resume`);
   * otherwise send the whole outline (`snapshot`). A null cursor always takes
   * the snapshot path.
   *
   * Both handshake frames carry `serverVersion` — the deploy the client is now
   * talking to. It rides here rather than on `change` frames because a reconnect
   * is exactly when a days-old tab meets a newer Worker (ADR 0046).
   */
  private initialFrame(since: number | null): ServerMessage {
    const seq = this.currentSeq();
    if (since !== null && since <= seq) {
      const oldest =
        this.sql
          .exec<{ m: number | null }>("SELECT MIN(seq) AS m FROM changelog")
          .toArray()[0]?.m ?? null;
      // Resumable iff the client is already current (nothing to send) or the
      // next frame it needs (since + 1) is still retained.
      const canResume =
        since === seq || (oldest !== null && since + 1 >= oldest);
      if (canResume) {
        const rows = this.sql
          .exec<{ seq: number; ops: string }>(
            "SELECT seq, ops FROM changelog WHERE seq > ? ORDER BY seq",
            since,
          )
          .toArray();
        return {
          type: "resume",
          seq,
          changes: rows.map((r) => ({
            seq: r.seq,
            ops: JSON.parse(r.ops) as ChangeOp[],
          })),
          serverVersion: APP_VERSION,
        };
      }
    }
    return {
      type: "snapshot",
      seq,
      nodes: this.getNodes(),
      serverVersion: APP_VERSION,
    };
  }

  // --- kv side-collections ---------------------------------------------------

  getKv(collection: string): unknown[] {
    return this.sql
      .exec<{ value: string }>(
        "SELECT value FROM kv WHERE collection = ?",
        collection,
      )
      .toArray()
      .map((r) => JSON.parse(r.value));
  }

  upsertKv(
    collection: string,
    rows: readonly { key: string; value: unknown }[],
  ): void {
    const ts = Date.now();
    for (const r of rows) {
      this.sql.exec(
        `INSERT INTO kv (collection, key, value, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(collection, key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
        collection,
        r.key,
        JSON.stringify(r.value),
        ts,
      );
    }
  }

  deleteKv(collection: string, keys: readonly string[]): void {
    for (const k of keys)
      this.sql.exec(
        "DELETE FROM kv WHERE collection = ? AND key = ?",
        collection,
        k,
      );
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
    );
    const row = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM kv WHERE collection = ? AND key = ?",
        collection,
        key,
      )
      .toArray()[0];
    return row ? JSON.parse(row.value) : value;
  }

  // --- one-time import from the legacy D1 tables -----------------------------

  isSeeded(): boolean {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seeded'")
      .toArray()[0];
    return row?.value === "1";
  }

  /** Idempotently load the user's existing rows (read from D1 by the Worker,
   *  which owns the D1 binding) into this DO, then mark it seeded so it never
   *  re-imports. Non-destructive: D1 is left intact. */
  seed(data: { nodes: Node[]; kv: KvRow[] }): void {
    if (this.isSeeded()) return;
    this.upsertNodes(data.nodes);
    for (const collection of new Set(data.kv.map((r) => r.collection))) {
      this.upsertKv(
        collection,
        data.kv
          .filter((r) => r.collection === collection)
          .map((r) => ({ key: r.key, value: r.value })),
      );
    }
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
    );
  }

  // --- operator restore (Point-in-Time Recovery, ticket #220) ----------------

  /**
   * Roll this DO's entire storage back to a point within Cloudflare's free
   * 30-day PITR window, driven by an admin-gated Worker route. Isolation is by
   * construction: DO = user, so restoring one object never touches another.
   *
   * Sequencing is the load-bearing subtlety. `ctx.abort()` restarts the object
   * IMMEDIATELY — calling it inline would kill this RPC's in-flight reply and the
   * operator would never receive `previousBookmark`, the handle that makes a bad
   * restore itself reversible (pass it back as `{ kind: "bookmark" }` to undo).
   * So we: capture the pre-recovery bookmark ("now"), resolve the target, ARM the
   * restore (`onNextSessionRestoreBookmark`, which persists across the restart),
   * return the two bookmarks, and only THEN — after the response has left the DO —
   * `ctx.abort()`. Because the restore is already armed and durable, a lost abort
   * timer (eviction) still applies on the next natural restart; the delay only
   * makes the rollback prompt for any live tabs.
   *
   * Live clients reconnect after the abort with their last-applied seq, which now
   * sits ABOVE the restored DO's seq (time went backwards). The DO's handshake
   * (`initialFrame`) already answers a `since > seq` cursor with a full snapshot,
   * not a resume, and the client's `resetAppliedSeq` drops its cursor to match —
   * so a restore can't leave a live tab on a broken resume (ADR 0008). No client
   * change needed; see docs/runbooks/restore-user-pitr.md.
   */
  async restoreToTime(
    point: RestorePoint,
  ): Promise<{ previousBookmark: string; targetBookmark: string }> {
    // The pre-recovery handle FIRST — this is "now", the undo target.
    const previousBookmark = await this.ctx.storage.getCurrentBookmark();
    const targetBookmark =
      point.kind === "bookmark"
        ? point.bookmark
        : await this.ctx.storage.getBookmarkForTime(point.at);
    await this.ctx.storage.onNextSessionRestoreBookmark(targetBookmark);
    setTimeout(() => {
      try {
        this.ctx.abort("point-in-time restore");
      } catch {
        // Already torn down / restarted — the armed restore still applies.
      }
    }, RESTORE_ABORT_DELAY_MS);
    return { previousBookmark, targetBookmark };
  }
}
