import { describe, expect, test } from "bun:test";

import { scopeRateLimitDb, type DbWithScopedWrites } from "./scope-db";

describe("scopeRateLimitDb", () => {
  test("passes expectedTable on patch/delete", async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const db = {
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
      patch: async (
        id: unknown,
        patch: Record<string, unknown>,
        expectedTable?: string,
      ) => {
        calls.push({ op: "patch", args: [id, patch, expectedTable] });
      },
      delete: async (id: unknown, expectedTable?: string) => {
        calls.push({ op: "delete", args: [id, expectedTable] });
      },
    } as unknown as DbWithScopedWrites;

    const scoped = scopeRateLimitDb(db, "ratelimit_buckets");
    await scoped.patch("raw-id" as never, { value: 1, ts: 2 });
    await scoped.delete("raw-id" as never);

    expect(calls).toEqual([
      {
        op: "patch",
        args: ["raw-id", { value: 1, ts: 2 }, "ratelimit_buckets"],
      },
      { op: "delete", args: ["raw-id", "ratelimit_buckets"] },
    ]);
  });

  test("forwards query/insert unchanged", async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const db = {
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
    } as unknown as DbWithScopedWrites;

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
