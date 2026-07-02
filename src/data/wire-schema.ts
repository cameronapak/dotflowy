/**
 * The shared wire contract, as `effect/Schema` — the SINGLE source of truth for
 * the `Node` / `ChangeOp` shapes AND the DO→client `ServerMessage` frames,
 * imported by BOTH the client (`src/data/realtime.ts`, `collection.ts`) and the
 * Worker (`worker/wire.ts`, `worker/outline-do.ts`).
 *
 * Why one module across both tsconfigs: the sync protocol has three copies of
 * these types today — the client's hand-written ones in realtime.ts, the DO's
 * hand-written ones in outline-do.ts, and the schema-derived ones in wire.ts.
 * Three copies of a wire type is three chances to drift. This is the leaf they
 * all derive from. It imports ONLY `effect/Schema` — no DOM lib, no
 * `cloudflare:workers` — so it type-checks cleanly under the app tsconfig (DOM),
 * the worker tsconfig (`@cloudflare/workers-types`), and the test tsconfig, and
 * a pure `bun test` can decode against it without any runtime.
 *
 * The concrete types (`Node`, `ChangeOp`, `ServerMessage`) are DERIVED from the
 * schemas (`Schema.Schema.Type`), so the validator and the type can never drift.
 * See docs/adr/0013 (sync socket) and docs/adr/0014 (trust boundary).
 */

import { Schema } from 'effect'

/** A node as it travels the wire — booleans are real booleans. Mirrors the
 *  client's `nodeSchema` (src/data/schema.ts) field-for-field; the DO stores the
 *  booleans as 0/1 integers and maps back via `rowToNode`. No defaults, no
 *  optionals (ADR 0003), so Encoded and Type are the same all-required shape. */
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
 *  full node; deletes carry just the key. */
const InsertOp = Schema.Struct({ op: Schema.Literal('insert'), value: NodeSchema })
const UpdateOp = Schema.Struct({ op: Schema.Literal('update'), value: NodeSchema })
const DeleteOp = Schema.Struct({ op: Schema.Literal('delete'), key: Schema.String })
export const ChangeOpSchema = Schema.Union([InsertOp, UpdateOp, DeleteOp])
export type ChangeOp = Schema.Schema.Type<typeof ChangeOpSchema>

/** A committed batch of ops at a monotonic sequence number. */
export const ChangeFrameSchema = Schema.Struct({
  seq: Schema.Number,
  ops: Schema.Array(ChangeOpSchema),
})
export type ChangeFrame = Schema.Schema.Type<typeof ChangeFrameSchema>

// --- DO → client frames -----------------------------------------------------
// `snapshot` = full state (initial connect or resync past the changelog window);
// `resume` = the gap since the client's cursor; `change` = a live mutation.

const SnapshotMessage = Schema.Struct({
  type: Schema.Literal('snapshot'),
  seq: Schema.Number,
  nodes: Schema.Array(NodeSchema),
})
const ResumeMessage = Schema.Struct({
  type: Schema.Literal('resume'),
  seq: Schema.Number,
  changes: Schema.Array(ChangeFrameSchema),
})
const ChangeMessage = Schema.Struct({
  type: Schema.Literal('change'),
  seq: Schema.Number,
  ops: Schema.Array(ChangeOpSchema),
})

/** The union of every DO→client frame. `realtime.ts` decodes inbound frames
 *  against this (closing the last unchecked `as ServerMessage` cast); the DO
 *  builds these frames and `satisfies` this type on the way out. */
export const ServerMessageSchema = Schema.Union([
  SnapshotMessage,
  ResumeMessage,
  ChangeMessage,
])
export type ServerMessage = Schema.Schema.Type<typeof ServerMessageSchema>
