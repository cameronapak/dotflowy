/**
 * The Worker's request-body schemas for /api/nodes and /api/kv — the single
 * source of truth for the Worker's request-body types AND their runtime
 * validation at the trust boundary.
 *
 * Why this file exists: the Worker receives untrusted JSON from the client and
 * forwards it into the per-user Durable Object's SQLite. A malformed body (e.g.
 * an op with no `value`) used to sail through an unchecked `as` cast and
 * dereference `undefined` deep inside the SQLite write loop — a 500 from inside
 * storage. Decoding each body against these schemas at the boundary turns that
 * into a clean typed `BadRequest` (→ 400) before it ever reaches the DO. See
 * docs/adr/0014-validate-the-worker-do-trust-boundary.md.
 *
 * `Node` / `ChangeOp` (and their schemas) come from the shared wire module
 * `../src/data/wire-schema.ts` — the one leaf both the client and the Worker
 * derive from, so the type the DO trusts can never drift from the type the
 * client sends. The request-body wrappers below stay worker-local (the client
 * never decodes a request body). Re-exported so existing importers
 * (worker/index.ts, worker/wire.test.ts) keep resolving `Node`/`ChangeOp` here.
 */

import { Schema } from 'effect'
import { ChangeOpSchema, NodeSchema } from '../src/data/wire-schema'

export { NodeSchema } from '../src/data/wire-schema'
export type { ChangeOp, Node } from '../src/data/wire-schema'

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
