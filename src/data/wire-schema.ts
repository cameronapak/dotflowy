import { Schema } from "effect";

// Shared by browser, Worker and fixtures. Keep this leaf free of browser and
// Cloudflare runtime imports. No defaults or optional Node fields: TanStack DB
// needs the encoded and decoded shapes to agree (ADR 0003).
export const NodeSchema = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  prevSiblingId: Schema.NullOr(Schema.String),
  text: Schema.String,
  isTask: Schema.Boolean,
  completed: Schema.Boolean,
  collapsed: Schema.Boolean,
  bookmarkedAt: Schema.NullOr(Schema.Number),
  locked: Schema.Boolean,
  mirrorOf: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  origin: Schema.NullOr(Schema.String),
  // Mutations enforce Kind exclusivity with isTask; old clients may send both,
  // so readers give kind precedence (ADR 0045).
  kind: Schema.NullOr(Schema.Literals(["paragraph", "embed", "numbered"])),
});
export type Node = Schema.Schema.Type<typeof NodeSchema>;

/** One node mutation in a change frame, discriminated on `op`. Upserts carry the
 *  full node; deletes carry just the key. */
const InsertOp = Schema.Struct({
  op: Schema.Literal("insert"),
  value: NodeSchema,
});
const UpdateOp = Schema.Struct({
  op: Schema.Literal("update"),
  value: NodeSchema,
});
const DeleteOp = Schema.Struct({
  op: Schema.Literal("delete"),
  key: Schema.String,
});
export const ChangeOpSchema = Schema.Union([InsertOp, UpdateOp, DeleteOp]);
export type ChangeOp = Schema.Schema.Type<typeof ChangeOpSchema>;

/** A committed batch of ops at a monotonic sequence number. */
export const ChangeFrameSchema = Schema.Struct({
  seq: Schema.Number,
  ops: Schema.Array(ChangeOpSchema),
  /** Transport correlation only: absent means an old client or external writer. */
  clientId: Schema.optional(Schema.String),
});
export type ChangeFrame = Schema.Schema.Type<typeof ChangeFrameSchema>;

export const WeekStartSchema = Schema.Literals(["sunday", "monday"]);
export const WeekStartPreferenceSchema = Schema.Struct({
  key: Schema.Literal("daily:week-start"),
  weekStart: WeekStartSchema,
});

const CalendarSyncStateSchema = Schema.Struct({
  weekStart: WeekStartSchema,
  upserts: Schema.optional(
    Schema.Array(Schema.Struct({ key: Schema.String, nodeId: Schema.String })),
  ),
  deletes: Schema.optional(Schema.Array(Schema.String)),
});
export type CalendarSyncState = Schema.Schema.Type<
  typeof CalendarSyncStateSchema
>;
const calendar = Schema.optional(CalendarSyncStateSchema);

// --- DO → client frames -----------------------------------------------------
// `snapshot` = full state (initial connect or resync past the changelog window);
// `resume` = the gap since the client's cursor; `change` = a live mutation.

/** The Worker's `package.json` version (`worker/version.ts`), stamped onto every
 *  handshake frame so a long-lived tab can notice its bundle has gone stale
 *  (ADR 0046, compared against `src/data/app-version.ts`). A changelog
 *  cannot inform a stale client, and stale clients are exactly who a MAJOR bump
 *  is for.
 *
 *  OPTIONAL, and it must stay that way: a `resume` from a DO that predates this
 *  field, and the e2e Worker mock, both omit it. Effect Schema ignores excess
 *  properties, so an OLD client decodes a new frame and drops it -- adding this
 *  cannot break a tab mid-session. (ADR 0003's no-optionals rule governs `Node`,
 *  where a default would make the field optional in the encoded type; a frame is
 *  not a persisted row.) */
const serverVersion = Schema.optional(Schema.String);

const SnapshotMessage = Schema.Struct({
  type: Schema.Literal("snapshot"),
  seq: Schema.Number,
  nodes: Schema.Array(NodeSchema),
  serverVersion,
  calendar,
});
const ResumeMessage = Schema.Struct({
  type: Schema.Literal("resume"),
  seq: Schema.Number,
  changes: Schema.Array(ChangeFrameSchema),
  serverVersion,
  calendar,
});
const ChangeMessage = Schema.Struct({
  type: Schema.Literal("change"),
  seq: Schema.Number,
  ops: Schema.Array(ChangeOpSchema),
  clientId: Schema.optional(Schema.String),
  calendar,
});

/** The union of every DO→client frame. `realtime.ts` decodes inbound frames
 *  against this (closing the last unchecked `as ServerMessage` cast); the DO
 *  builds these frames and `satisfies` this type on the way out. */
export const ServerMessageSchema = Schema.Union([
  SnapshotMessage,
  ResumeMessage,
  ChangeMessage,
]);
export type ServerMessage = Schema.Schema.Type<typeof ServerMessageSchema>;
