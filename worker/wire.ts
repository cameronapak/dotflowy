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

import { Schema } from "effect";

import { ChangeOpSchema, NodeSchema } from "../src/data/wire-schema";

export { NodeSchema } from "../src/data/wire-schema";
export type { ChangeOp, Node } from "../src/data/wire-schema";

// --- Request-body schemas (the /api/nodes + /api/kv trust boundary) ----------

/** POST /api/nodes. Either an atomic structural batch (`ops`) or the legacy
 *  upsert / first-run seed (`nodes`); both optional, an empty body is a no-op. */
export const NodesPostBody = Schema.Struct({
  ops: Schema.optional(Schema.Array(ChangeOpSchema)),
  nodes: Schema.optional(Schema.Array(NodeSchema)),
});

/** PATCH /api/nodes — single-field edits. `changes` stays an open record; the DO
 *  filters it against its writable-column allowlist, so it can't be injected. */
export const NodesPatchBody = Schema.Struct({
  updates: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      changes: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});

/** DELETE /api/nodes. */
export const NodesDeleteBody = Schema.Struct({
  ids: Schema.Array(Schema.String),
});

/** POST /api/kv?op=claim — atomic get-or-create on one key. */
export const KvClaimBody = Schema.Struct({
  key: Schema.String,
  value: Schema.Unknown,
});

/** POST /api/kv — batch upsert of side-collection rows. */
export const KvUpsertBody = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({ key: Schema.String, value: Schema.Unknown }),
  ),
});

/** DELETE /api/kv. */
export const KvDeleteBody = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

/** POST /api/waitlist — public alpha-waitlist signup (invite-only signup gate,
 *  worker/auth.ts). Email plausibility is checked in the route handler; the
 *  schema only guards the shape. */
export const WaitlistPostBody = Schema.Struct({
  email: Schema.String,
  source: Schema.optional(Schema.String),
});

/** POST /api/admin/invite — mint per-email single-use invite codes (#251).
 *  Admin-gated in the route (session + ADMIN_EMAILS). Provide `emails` to invite
 *  specific addresses, or `all`/`limit` to pull pending waitlist rows. The
 *  schema only guards shape; targeting is resolved in the route. */
export const AdminInvitePostBody = Schema.Struct({
  emails: Schema.optional(Schema.Array(Schema.String)),
  all: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
});

/** POST /api/admin/announce — email the launch "Dotflowy is open" blast (#294).
 *  Same shape + admin gate as /api/admin/invite. Provide `emails` to announce to
 *  specific addresses, or `all`/`limit` to pull not-yet-notified waitlist rows.
 *  The schema only guards shape; targeting + idempotent stamping live in the
 *  route (runAnnounceBatch -> sendAnnouncements). */
export const AdminAnnouncePostBody = Schema.Struct({
  emails: Schema.optional(Schema.Array(Schema.String)),
  all: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
});

/** POST /api/admin/restore — restore one user's outline to a point in time via
 *  the DO's 30-day PITR (#220). Admin-gated in the route (session + ADMIN_EMAILS).
 *  Identify the user by `email` OR `userId`; restore to a time (`at`, epoch ms or
 *  ISO string) OR a raw `bookmark` (the undo path). The schema only guards shape —
 *  the exactly-one-of rules and the 30-day window are validated in the route
 *  (resolveRestorePoint) and mapped to a clean 400. */
export const AdminRestorePostBody = Schema.Struct({
  email: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  bookmark: Schema.optional(Schema.String),
});

/** Restore one user from an R2 snapshot (#221): the target (exactly one of
 *  userId/email, enforced in the route like the PITR restore) plus the UTC
 *  calendar date of the backup object to load (shape-checked in the route via
 *  `isBackupDateKey` — pure, worker/backup.ts). */
export const AdminSnapshotRestorePostBody = Schema.Struct({
  email: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
  date: Schema.String,
});
