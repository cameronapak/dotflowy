import { describe, expect, test } from "bun:test";

import { scopeRateLimitDb, type DbWithAsId } from "./scope-db";

describe("scopeRateLimitDb", () => {
  test("brands patch/delete ids with asId(table, …)", async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const db = {
      asId: (table: string, id: string) => {
        calls.push({ op: "asId", args: [table, id] });
        return `branded:${table}:${id}`;
      },
      query: (table: string) => {
        calls.push({ op: "query", args: [table] });
        return {
          withIndex: () => ({
            first: async () => null,
          }),
        };
      },
      insert: async (table: string, doc: Record<string, unknown>) => {
        calls.push({ op: "insert", args: [table, doc] });
        return "new-id" as never;
      },
      patch: async (id: unknown, patch: Record<string, unknown>) => {
        calls.push({ op: "patch", args: [id, patch] });
      },
      delete: async (id: unknown) => {
        calls.push({ op: "delete", args: [id] });
      },
    } as unknown as DbWithAsId;

    const scoped = scopeRateLimitDb(db, "ratelimit_buckets");
    await scoped.patch("raw-id" as never, { value: 1, ts: 2 });
    await scoped.delete("raw-id" as never);

    expect(calls).toEqual([
      { op: "asId", args: ["ratelimit_buckets", "raw-id"] },
      {
        op: "patch",
        args: ["branded:ratelimit_buckets:raw-id", { value: 1, ts: 2 }],
      },
      { op: "asId", args: ["ratelimit_buckets", "raw-id"] },
      { op: "delete", args: ["branded:ratelimit_buckets:raw-id"] },
    ]);
  });

  test("forwards query/insert unchanged", async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const db = {
      asId: (table: string, id: string) => `${table}:${id}`,
      query: (table: string) => {
        calls.push({ op: "query", args: [table] });
        return {
          withIndex: () => ({
            first: async () => null,
          }),
        };
      },
      insert: async (table: string, doc: Record<string, unknown>) => {
        calls.push({ op: "insert", args: [table, doc] });
        return "id" as never;
      },
      patch: async () => {},
      delete: async () => {},
    } as unknown as DbWithAsId;

    const scoped = scopeRateLimitDb(db, "ratelimit_buckets");
    scoped.query("ratelimit_buckets");
    await scoped.insert("ratelimit_buckets", { key: "k", value: 1, ts: 0 });

    expect(calls).toEqual([
      { op: "query", args: ["ratelimit_buckets"] },
      {
        op: "insert",
        args: ["ratelimit_buckets", { key: "k", value: 1, ts: 0 }],
      },
    ]);
  });
});
