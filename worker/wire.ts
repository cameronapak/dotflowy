/**
 * The wire contract for /api/nodes and /api/kv, as Effect Schemas — the single
 * source of truth for the Worker's request-body types AND their runtime
 * validation at the trust boundary.
 *
 * Why this file exists (and why the schemas, not hand-written types, are
 * canonical worker-side): the Worker receives untrusted JSON from the client and
 * forwards it into the per-user Durable Object's SQLite. A malformed body (e.g.
 * an op with no `value`) used to sail through an unchecked `as` cast and
 * dereference `undefined` deep inside the SQLite write loop — a 500 from inside
 * storage. Decoding each body against these schemas at the boundary turns that
 * into a clean typed `BadRequest` (→ 400) before it ever reaches the DO. See
 * docs/adr/0014-validate-the-worker-do-trust-boundary.md.
 *
 * `Node` and `ChangeOp` are DERIVED from their schemas (`Schema.Schema.Type`),
 * so the validator and the type the DO trusts can never drift. The client keeps
 * its own hand-written copy of these types in src/data/realtime.ts (a different
 * tsconfig, no Effect at the type layer) — kept in lockstep on purpose, same as
 * before; the client is the originator, the Worker is the gate.
 *
 * Deliberately imports ONLY `effect/Schema` — no `cloudflare:workers`, no DOM
 * lib — so a pure `bun test` can import and exercise the decode path without the
 * Workers runtime (mirrors the realtime socket's pure-logic test tier).
 */

import { Schema } from 'effect'

/** A node as the client speaks it — booleans are real booleans. The decoded
 *  type mirrors the `Node` interface in src/data/schema.ts. */
export const NodeSchema = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  prevSiblingId: Schema.NullOr(Schema.String),
  text: Schema.String,
  isTask: Schema.Boolean,
  completed: Schema.Boolean,
  collapsed: Schema.Boolean,
  bookmarkedAt: Schema.NullOr(Schema.Number),
  // Mirror pointer (ADR 0022): null = own source, an id = a mirror of that node.
  // Required + nullable at the boundary, same as every other field — the client
  // always sends it (makeNode), so a body without it is malformed (→ 400).
  mirrorOf: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type Node = Schema.Schema.Type<typeof NodeSchema>

/** One node mutation in a change frame, discriminated on `op`. Upserts carry the
 *  full node; deletes carry just the key. The union reproduces the hand-written
 *  wire type exactly, so the DO and the client stay byte-compatible. */
const InsertOp = Schema.Struct({ op: Schema.Literal('insert'), value: NodeSchema })
const UpdateOp = Schema.Struct({ op: Schema.Literal('update'), value: NodeSchema })
const DeleteOp = Schema.Struct({ op: Schema.Literal('delete'), key: Schema.String })
const ChangeOpSchema = Schema.Union([InsertOp, UpdateOp, DeleteOp])
export type ChangeOp = Schema.Schema.Type<typeof ChangeOpSchema>

// --- Request-body schemas (the /api/nodes + /api/kv trust boundary) ----------

/** POST /api/nodes. Either an atomic structural batch (`ops`) or the legacy
 *  upsert / first-run seed (`nodes`); both optional, an empty body is a no-op. */
export const NodesPostBody = Schema.Struct({
  ops: Schema.optional(Schema.Array(ChangeOpSchema)),
  nodes: Schema.optional(Schema.Array(NodeSchema)),
})

/** PATCH /api/nodes — single-field edits. `changes` stays an open record; the DO
 *  filters it against its writable-column allowlist, so it can't be injected. */
export const NodesPatchBody = Schema.Struct({
  updates: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      changes: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
})

/** DELETE /api/nodes. */
export const NodesDeleteBody = Schema.Struct({ ids: Schema.Array(Schema.String) })

/** POST /api/kv?op=claim — atomic get-or-create on one key. */
export const KvClaimBody = Schema.Struct({ key: Schema.String, value: Schema.Unknown })

/** POST /api/kv — batch upsert of side-collection rows. */
export const KvUpsertBody = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.Unknown })),
})

/** DELETE /api/kv. */
export const KvDeleteBody = Schema.Struct({ keys: Schema.Array(Schema.String) })
