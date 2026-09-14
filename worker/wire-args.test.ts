import { v } from "lunorash/server";
/**
 * Regression: changeOpArg must accept null on nullable wire fields even when
 * generated FunctionReference types collapse .nullable() to non-null
 * (lunorash alpha.166 codegen). Exercises the real Lunora validator, not the
 * planner.
 */
import { describe, expect, test } from "vitest";

import { changeOpArg } from "../lunora/wire-args";

const opsArg = v.array(changeOpArg);

const nullableNode = {
  id: "n1",
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
  kind: null,
} as const;

describe("changeOpArg nullable wire fields", () => {
  test("accepts insert with all nullable fields null", () => {
    const parsed = changeOpArg.parse({ op: "insert", value: nullableNode });
    expect(parsed).toEqual({ op: "insert", value: { ...nullableNode } });
  });

  test("accepts update with all nullable fields null", () => {
    const parsed = changeOpArg.parse({ op: "update", value: nullableNode });
    expect(parsed).toEqual({ op: "update", value: { ...nullableNode } });
  });

  test("accepts a batch of insert + update through ops array validator", () => {
    const parsed = opsArg.parse([
      { op: "insert", value: nullableNode },
      { op: "update", value: { ...nullableNode, id: "n2", text: "world" } },
      { op: "delete", key: "gone" },
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      op: "insert",
      value: { parentId: null },
    });
    expect(parsed[1]).toMatchObject({
      op: "update",
      value: { mirrorOf: null },
    });
    expect(parsed[2]).toEqual({ op: "delete", key: "gone" });
  });
});
