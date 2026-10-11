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

import { expect, test } from "bun:test";
import { Schema } from "effect";

import {
  AdminRestorePostBody,
  KvClaimBody,
  KvDeleteBody,
  KvUpsertBody,
  NodesDeleteBody,
  NodesPatchBody,
  NodesPostBody,
  WaitlistPostBody,
  WeekStartPostBody,
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
  locked: false,
  mirrorOf: null,
  createdAt: 1,
  updatedAt: 1,
  origin: null,
  kind: null,
});

type AnyBody = Schema.Codec<unknown, unknown, never, never>;

/** Undecoded request-body payloads as the boundary schemas receive them. */
type WirePayload = { readonly [key: string]: Schema.Json };

const { text: _text, ...missingText } = node("a");
const { mirrorOf: _mirrorOf, ...missingMirrorOf } = node("a");

test("NodesPostBody decodes ops with correlation and history metadata", () => {
  const post = Schema.decodeUnknownSync(NodesPostBody)({
    ops: [{ op: "delete", key: "a" }],
    clientId: "page-1",
    expectedSeq: 12,
  });
  expect(post.clientId).toBe("page-1");
  expect(post.expectedSeq).toBe(12);
});

test.each<[string, AnyBody, WirePayload]>([
  [
    "NodesPostBody: an atomic structural batch of ops",
    NodesPostBody,
    {
      ops: [
        { op: "insert", value: node("a") },
        { op: "update", value: node("b") },
        { op: "delete", key: "c" },
      ],
    },
  ],
  [
    "NodesPostBody: the legacy nodes-upsert / seed shape",
    NodesPostBody,
    { nodes: [node("a"), node("b")] },
  ],
  ["NodesPostBody: an empty no-op write", NodesPostBody, {}],
  [
    "NodesPatchBody: field updates with an open changes record and clientId",
    NodesPatchBody,
    {
      updates: [{ id: "a", changes: { text: "x", completed: true } }],
      clientId: "page-1",
    },
  ],
  [
    "NodesDeleteBody: an array of ids with clientId",
    NodesDeleteBody,
    { ids: ["a", "b"], clientId: "page-1" },
  ],
  [
    "KvClaimBody: key + arbitrary value",
    KvClaimBody,
    { key: "today", value: { nodeId: "n1" } },
  ],
  [
    "KvUpsertBody: rows",
    KvUpsertBody,
    { rows: [{ key: "#a", value: { color: "red" } }] },
  ],
  ["KvDeleteBody: keys", KvDeleteBody, { keys: ["#a", "#b"] }],
  [
    "WaitlistPostBody: email + source",
    WaitlistPostBody,
    { email: "a@b.com", source: "landing" },
  ],
  ["WaitlistPostBody: email alone", WaitlistPostBody, { email: "a@b.com" }],
  [
    "AdminRestorePostBody: email + ISO time",
    AdminRestorePostBody,
    { email: "a@b.com", at: "2026-07-16T12:00:00Z" },
  ],
  [
    "AdminRestorePostBody: userId + epoch-ms time",
    AdminRestorePostBody,
    { userId: "usr_1", at: 1_752_000_000_000 },
  ],
  [
    "AdminRestorePostBody: a raw bookmark (the undo path)",
    AdminRestorePostBody,
    { userId: "usr_1", bookmark: "bk-abc" },
  ],
])("accepts %s", (_label, schema, input) => {
  expect(() => Schema.decodeUnknownSync(schema)(input)).not.toThrow();
});

test.each<[string, AnyBody, WirePayload]>([
  [
    "NodesPostBody: a non-integer expectedSeq",
    NodesPostBody,
    { ops: [], expectedSeq: 1.5 },
  ],
  // The half-applied 500 the gate prevents.
  [
    "NodesPostBody: an insert op missing its value",
    NodesPostBody,
    { ops: [{ op: "insert" }] },
  ],
  [
    "NodesPostBody: a delete op missing its key",
    NodesPostBody,
    { ops: [{ op: "delete" }] },
  ],
  [
    "NodesPostBody: an unknown op discriminant",
    NodesPostBody,
    { ops: [{ op: "frobnicate", value: node("a") }] },
  ],
  [
    "NodesPostBody: a node with a wrong field type",
    NodesPostBody,
    { ops: [{ op: "insert", value: { ...node("a"), isTask: "yes" } }] },
  ],
  [
    "NodesPostBody: a node missing text",
    NodesPostBody,
    { ops: [{ op: "insert", value: missingText }] },
  ],
  // mirrorOf is required + nullable at the boundary (ADR 0022).
  [
    "NodesPostBody: a node missing mirrorOf",
    NodesPostBody,
    { ops: [{ op: "insert", value: missingMirrorOf }] },
  ],
  [
    "NodesPatchBody: an update missing its changes",
    NodesPatchBody,
    { updates: [{ id: "a" }] },
  ],
  ["NodesPatchBody: a missing updates array", NodesPatchBody, {}],
  ["NodesDeleteBody: a non-string id", NodesDeleteBody, { ids: ["a", 7] }],
  ["NodesDeleteBody: a missing ids array", NodesDeleteBody, {}],
  ["KvClaimBody: a missing key", KvClaimBody, { value: 1 }],
  [
    "KvUpsertBody: a row missing its key",
    KvUpsertBody,
    { rows: [{ value: 1 }] },
  ],
  ["KvDeleteBody: a non-string key", KvDeleteBody, { keys: [1] }],
  ["WaitlistPostBody: a missing email", WaitlistPostBody, {}],
  ["WaitlistPostBody: a non-string email", WaitlistPostBody, { email: 42 }],
  [
    "AdminRestorePostBody: an object at",
    AdminRestorePostBody,
    { userId: "usr_1", at: { when: 1 } },
  ],
  [
    "AdminRestorePostBody: a non-string email",
    AdminRestorePostBody,
    { email: 42 },
  ],
])("rejects %s", (_label, schema, input) => {
  expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow();
});

test("WeekStartPostBody separates targetless canonicalization from an explicit preference change", () => {
  const decode = Schema.decodeUnknownSync(WeekStartPostBody);
  expect(decode({ operation: "canonicalize" })).toEqual({
    operation: "canonicalize",
  });
  expect(decode({ operation: "set", weekStart: "sunday" })).toEqual({
    operation: "set",
    weekStart: "sunday",
  });
  // Effect Struct discards excess properties. The discriminant still
  // guarantees this cannot become an explicit preference change.
  expect(decode({ operation: "canonicalize", weekStart: "sunday" })).toEqual({
    operation: "canonicalize",
  });
  expect(() => decode({ operation: "set" })).toThrow();
  expect(() => decode({ operation: "change", weekStart: "sunday" })).toThrow();
});
