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

import { describe, expect, it } from "bun:test";
import { Exit, Schema } from "effect";

import { makeNode } from "./tree";
import { ChangeOpSchema, NodeSchema, ServerMessageSchema } from "./wire-schema";

type AnySchema = Schema.Codec<unknown, unknown, never, never>;

const decodes = (schema: AnySchema, input: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(input));

const a = makeNode({ id: "a", text: "alpha" });
const b = makeNode({ id: "b", text: "bravo" });

describe("NodeSchema", () => {
  it("accepts a complete node", () => {
    expect(decodes(NodeSchema, a)).toBe(true);
  });

  it("rejects a wrong field type", () => {
    expect(decodes(NodeSchema, { ...a, isTask: "yes" })).toBe(false);
  });

  it("rejects a missing required field (mirrorOf, ADR 0022)", () => {
    const { mirrorOf: _omit, ...missing } = a;
    expect(decodes(NodeSchema, missing)).toBe(false);
  });
});

describe("ChangeOpSchema", () => {
  it("accepts insert / update / delete ops", () => {
    expect(decodes(ChangeOpSchema, { op: "insert", value: a })).toBe(true);
    expect(decodes(ChangeOpSchema, { op: "update", value: b })).toBe(true);
    expect(decodes(ChangeOpSchema, { op: "delete", key: "a" })).toBe(true);
  });

  it("rejects an insert op missing its value", () => {
    expect(decodes(ChangeOpSchema, { op: "insert" })).toBe(false);
  });

  it("rejects a delete op missing its key", () => {
    expect(decodes(ChangeOpSchema, { op: "delete" })).toBe(false);
  });

  it("rejects an unknown op discriminant", () => {
    expect(decodes(ChangeOpSchema, { op: "frobnicate", value: a })).toBe(false);
  });
});

describe("ServerMessageSchema (DO → client frames)", () => {
  it("accepts a snapshot frame", () => {
    expect(
      decodes(ServerMessageSchema, { type: "snapshot", seq: 3, nodes: [a, b] }),
    ).toBe(true);
  });

  it("accepts an empty snapshot (fresh outline)", () => {
    expect(
      decodes(ServerMessageSchema, { type: "snapshot", seq: 0, nodes: [] }),
    ).toBe(true);
  });

  it("accepts a resume frame carrying change frames", () => {
    expect(
      decodes(ServerMessageSchema, {
        type: "resume",
        seq: 5,
        changes: [{ seq: 5, ops: [{ op: "update", value: a }] }],
      }),
    ).toBe(true);
  });

  it("accepts a live change frame", () => {
    expect(
      decodes(ServerMessageSchema, {
        type: "change",
        seq: 6,
        ops: [
          { op: "insert", value: b },
          { op: "delete", key: "a" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects an unknown frame type", () => {
    expect(decodes(ServerMessageSchema, { type: "bogus", seq: 1 })).toBe(false);
  });

  it("rejects a change frame with no seq", () => {
    expect(decodes(ServerMessageSchema, { type: "change", ops: [] })).toBe(
      false,
    );
  });

  it("rejects a change frame whose op is malformed (the half-applied write the gate prevents)", () => {
    expect(
      decodes(ServerMessageSchema, {
        type: "change",
        seq: 1,
        ops: [{ op: "insert" }],
      }),
    ).toBe(false);
  });

  it("rejects a snapshot whose nodes array holds a bad node", () => {
    expect(
      decodes(ServerMessageSchema, {
        type: "snapshot",
        seq: 1,
        nodes: [{ ...a, id: 5 }],
      }),
    ).toBe(false);
  });

  it("rejects a non-object frame", () => {
    expect(decodes(ServerMessageSchema, "not a frame")).toBe(false);
    expect(decodes(ServerMessageSchema, null)).toBe(false);
  });
});
