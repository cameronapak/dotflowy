/**
 * Pure-logic tests for the Worker's request-body schemas (worker/wire.ts) — the
 * trust-boundary gate that turns a malformed body into a clean 400 instead of a
 * 500 from deep inside the DO's SQLite write loop. Decoding is side-effect-free,
 * so it belongs in the `bun test` pure tier (like realtime.test.ts), not e2e:
 * the seedOutline mock fakes the Worker in-memory and never exercises this path.
 *
 * `decodeUnknownSync` throws a `SchemaError` on a shape the schema rejects and
 * returns the decoded value otherwise — exactly the accept/reject the live
 * `decodeBody` helper makes at the boundary. See docs/adr/0014.
 */

import { describe, expect, it } from "bun:test";
import { Schema } from "effect";

import {
  KvClaimBody,
  KvDeleteBody,
  KvUpsertBody,
  NodesDeleteBody,
  NodesPatchBody,
  NodesPostBody,
  WaitlistPostBody,
  type Node,
} from "./wire";

const node = (id: string): Node => ({
  id,
  parentId: null,
  prevSiblingId: null,
  text: "hello",
  isTask: false,
  completed: false,
  collapsed: false,
  bookmarkedAt: null,
  mirrorOf: null,
  createdAt: 1,
  updatedAt: 1,
  origin: null,
});

type AnyBody = Schema.Codec<unknown, unknown, never, never>;

const accepts = (schema: AnyBody, input: unknown) =>
  expect(() => Schema.decodeUnknownSync(schema)(input)).not.toThrow();

const rejects = (schema: AnyBody, input: unknown) =>
  expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow();

describe("NodesPostBody (POST /api/nodes)", () => {
  it("accepts an atomic structural batch of ops", () => {
    accepts(NodesPostBody, {
      ops: [
        { op: "insert", value: node("a") },
        { op: "update", value: node("b") },
        { op: "delete", key: "c" },
      ],
    });
  });

  it("accepts the legacy nodes-upsert / seed shape", () => {
    accepts(NodesPostBody, { nodes: [node("a"), node("b")] });
  });

  it("accepts an empty body (both fields optional — a no-op write)", () => {
    accepts(NodesPostBody, {});
  });

  it("rejects an insert op missing its value (the half-applied 500 the gate prevents)", () => {
    rejects(NodesPostBody, { ops: [{ op: "insert" }] });
  });

  it("rejects a delete op missing its key", () => {
    rejects(NodesPostBody, { ops: [{ op: "delete" }] });
  });

  it("rejects an unknown op discriminant", () => {
    rejects(NodesPostBody, { ops: [{ op: "frobnicate", value: node("a") }] });
  });

  it("rejects a node with a wrong field type", () => {
    rejects(NodesPostBody, {
      ops: [{ op: "insert", value: { ...node("a"), isTask: "yes" } }],
    });
  });

  it("rejects a node missing a required field", () => {
    const { text: _omit, ...missingText } = node("a");
    rejects(NodesPostBody, { ops: [{ op: "insert", value: missingText }] });
  });

  it("rejects a node missing mirrorOf (required + nullable at the boundary — ADR 0022)", () => {
    const { mirrorOf: _omit, ...missingMirrorOf } = node("a");
    rejects(NodesPostBody, { ops: [{ op: "insert", value: missingMirrorOf }] });
  });
});

describe("NodesPatchBody (PATCH /api/nodes)", () => {
  it("accepts field updates with an open changes record", () => {
    accepts(NodesPatchBody, {
      updates: [{ id: "a", changes: { text: "x", completed: true } }],
    });
  });

  it("rejects an update missing its changes record", () => {
    rejects(NodesPatchBody, { updates: [{ id: "a" }] });
  });

  it("rejects a missing updates array", () => {
    rejects(NodesPatchBody, {});
  });
});

describe("NodesDeleteBody (DELETE /api/nodes)", () => {
  it("accepts an array of ids", () => {
    accepts(NodesDeleteBody, { ids: ["a", "b"] });
  });

  it("rejects a non-string id", () => {
    rejects(NodesDeleteBody, { ids: ["a", 7] });
  });

  it("rejects a missing ids array", () => {
    rejects(NodesDeleteBody, {});
  });
});

describe("kv bodies (/api/kv)", () => {
  it("accepts a claim body (key + arbitrary value)", () => {
    accepts(KvClaimBody, { key: "today", value: { nodeId: "n1" } });
  });

  it("rejects a claim body missing its key", () => {
    rejects(KvClaimBody, { value: 1 });
  });

  it("accepts an upsert body of rows", () => {
    accepts(KvUpsertBody, { rows: [{ key: "#a", value: { color: "red" } }] });
  });

  it("rejects an upsert row missing its key", () => {
    rejects(KvUpsertBody, { rows: [{ value: 1 }] });
  });

  it("accepts a delete body of keys", () => {
    accepts(KvDeleteBody, { keys: ["#a", "#b"] });
  });

  it("rejects a non-string key in a delete body", () => {
    rejects(KvDeleteBody, { keys: [1] });
  });
});

describe("WaitlistPostBody (POST /api/waitlist)", () => {
  it("accepts an email with an optional source", () => {
    accepts(WaitlistPostBody, { email: "a@b.com", source: "landing" });
    accepts(WaitlistPostBody, { email: "a@b.com" });
  });

  it("rejects a missing or non-string email", () => {
    rejects(WaitlistPostBody, {});
    rejects(WaitlistPostBody, { email: 42 });
  });
});
