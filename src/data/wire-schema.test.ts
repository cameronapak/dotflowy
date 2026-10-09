/**
 * Pure-logic tests for the shared wire schema (src/data/wire-schema.ts) — the
 * one leaf the client's socket decoder and the Worker's DO broadcaster both
 * derive from. This tier proves the `ServerMessage` decode that realtime.ts's
 * `decodeFrame` runs on every inbound frame (ADR 0013): a well-formed frame
 * decodes to a success Exit, a malformed one to a failure Exit — the exact
 * accept/reject that turns the last unchecked `as ServerMessage` cast into a
 * real validation. Decoding is side-effect-free, so it belongs here, not e2e:
 * seedOutline mocks the socket and never runs this path against a real frame.
 *
 * (The realtime socket's reconnect/handshake policy is covered separately in
 * realtime.test.ts; this file only exercises the schema.)
 */

import { expect, test } from "bun:test";
import { Exit, Schema } from "effect";

import { createNode } from "./tree";
import { ChangeOpSchema, NodeSchema, ServerMessageSchema } from "./wire-schema";

type AnySchema = Schema.Codec<unknown, unknown, never, never>;

/** Valid payloads plus the malformed shapes the reject-cases feed. */
type DecodeInput =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: Schema.Json };

const decodes = (schema: AnySchema, input: DecodeInput) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(input));

const a = createNode({ id: "a", text: "alpha" });
const b = createNode({ id: "b", text: "bravo" });

const { mirrorOf: _omit, ...missingMirrorOf } = a;

test.each<[string, AnySchema, DecodeInput]>([
  ["a complete node", NodeSchema, a],
  ["an insert op", ChangeOpSchema, { op: "insert", value: a }],
  ["an update op", ChangeOpSchema, { op: "update", value: b }],
  ["a delete op", ChangeOpSchema, { op: "delete", key: "a" }],
  [
    "a snapshot frame",
    ServerMessageSchema,
    { type: "snapshot", seq: 3, nodes: [a, b] },
  ],
  [
    "an empty snapshot (fresh outline)",
    ServerMessageSchema,
    { type: "snapshot", seq: 0, nodes: [] },
  ],
  [
    "a resume frame carrying change frames",
    ServerMessageSchema,
    {
      type: "resume",
      seq: 5,
      changes: [{ seq: 5, ops: [{ op: "update", value: a }] }],
    },
  ],
  [
    "a live change frame",
    ServerMessageSchema,
    {
      type: "change",
      seq: 6,
      ops: [
        { op: "insert", value: b },
        { op: "delete", key: "a" },
      ],
    },
  ],
  [
    "a change frame with an atomic calendar state and index delta",
    ServerMessageSchema,
    {
      type: "change",
      seq: 7,
      ops: [],
      calendar: {
        weekStart: "sunday",
        upserts: [{ key: "week:2030-06-09", nodeId: "week" }],
        deletes: ["week:2030-06-10"],
      },
    },
  ],
  [
    "a snapshot frame with calendar state",
    ServerMessageSchema,
    { type: "snapshot", seq: 7, nodes: [], calendar: { weekStart: "sunday" } },
  ],
])("accepts %s", (_name, schema, input) => {
  expect(decodes(schema, input)).toBe(true);
});

test.each<[string, AnySchema, DecodeInput]>([
  ["a wrong node field type", NodeSchema, { ...a, isTask: "yes" }],
  ["a node missing mirrorOf (ADR 0022)", NodeSchema, missingMirrorOf],
  ["an insert op missing its value", ChangeOpSchema, { op: "insert" }],
  ["a delete op missing its key", ChangeOpSchema, { op: "delete" }],
  [
    "an unknown op discriminant",
    ChangeOpSchema,
    { op: "frobnicate", value: a },
  ],
  ["an unknown frame type", ServerMessageSchema, { type: "bogus", seq: 1 }],
  [
    "a change frame with no seq",
    ServerMessageSchema,
    { type: "change", ops: [] },
  ],
  // The half-applied write the gate prevents.
  [
    "a change frame whose op is malformed",
    ServerMessageSchema,
    { type: "change", seq: 1, ops: [{ op: "insert" }] },
  ],
  [
    "a snapshot whose nodes array holds a bad node",
    ServerMessageSchema,
    { type: "snapshot", seq: 1, nodes: [{ ...a, id: 5 }] },
  ],
  ["a string frame", ServerMessageSchema, "not a frame"],
  ["a null frame", ServerMessageSchema, null],
])("rejects %s", (_name, schema, input) => {
  expect(decodes(schema, input)).toBe(false);
});

test("keeps clientId correlation on live and resumed change frames", () => {
  const change = Schema.decodeUnknownSync(ServerMessageSchema)({
    type: "change",
    seq: 6,
    ops: [{ op: "update", value: a }],
    clientId: "page-1",
  });
  const resume = Schema.decodeUnknownSync(ServerMessageSchema)({
    type: "resume",
    seq: 6,
    changes: [
      {
        seq: 6,
        ops: [{ op: "update", value: a }],
        clientId: "page-1",
      },
    ],
  });

  expect(change).toHaveProperty("clientId", "page-1");
  expect(resume).toHaveProperty("changes.0.clientId", "page-1");
});
