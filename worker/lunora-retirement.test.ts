import { describe, expect, it } from "bun:test";

import type { Node } from "../src/data/wire-schema";

import {
  buildClassicTarget,
  classifyRetirement,
  retirementSnapshotKey,
  validateLunoraSnapshot,
  validateNodeGraph,
} from "./lunora-retirement";

const node = (
  id: string,
  parentId: string | null,
  prevSiblingId: string | null,
): Node => ({
  id,
  parentId,
  prevSiblingId,
  text: id,
  isTask: false,
  completed: false,
  collapsed: false,
  bookmarkedAt: null,
  mirrorOf: null,
  createdAt: 1,
  updatedAt: 1,
  origin: null,
  kind: null,
});

function snapshot(nodes: Node[]) {
  return {
    version: 1,
    exportedAt: 10,
    userId: "u1",
    nodes: nodes.map((row) => ({ ...row, userId: "u1" })),
    dailyIndex: [{ key: "today", nodeId: "b", touchedAt: 2, userId: "u1" }],
    tagColors: [{ tag: "work", color: "red", userId: "u1" }],
    savedQueries: [
      { id: "q1", name: "Q", query: "is:todo", createdAt: 3, userId: "u1" },
    ],
    migrateState: [{ nodesAt: 4, kvAt: 5, userId: "u1" }],
  };
}

describe("retirement snapshot validation", () => {
  it("accepts a complete asymmetric tree and all side collections", () => {
    const rows = [
      node("a", null, null),
      node("b", "a", null),
      node("c", "a", "b"),
    ];
    expect(validateLunoraSnapshot(snapshot(rows), "u1")).toEqual({ ok: true });
  });

  it("rejects disconnected sibling chains and parent cycles", () => {
    expect(
      validateNodeGraph([node("a", null, null), node("b", null, null)]),
    ).toEqual({
      ok: false,
      reason: "parent root has 2 sibling heads",
    });
    expect(
      validateNodeGraph([node("a", "b", null), node("b", "a", null)]).ok,
    ).toBe(false);
  });

  it("rejects missing watermarks, ownership drift, and dangling daily references", () => {
    const base = snapshot([node("a", null, null), node("b", "a", null)]);
    expect(
      validateLunoraSnapshot(
        { ...base, migrateState: [{ nodesAt: 4, kvAt: null, userId: "u1" }] },
        "u1",
      ).ok,
    ).toBe(false);
    expect(
      validateLunoraSnapshot(
        { ...base, tagColors: [{ ...base.tagColors[0]!, userId: "u2" }] },
        "u1",
      ).ok,
    ).toBe(false);
    expect(
      validateLunoraSnapshot(
        {
          ...base,
          dailyIndex: [{ ...base.dailyIndex[0]!, nodeId: "missing" }],
        },
        "u1",
      ).ok,
    ).toBe(false);
  });
});

describe("retirement classification", () => {
  const valid = { ok: true } as const;
  const invalid = { ok: false, reason: "bad" } as const;

  it("keeps preference-off users classic unless Lunora contains data", () => {
    expect(
      classifyRetirement({
        preferenceEnabled: false,
        classic: valid,
        lunora: invalid,
        lunoraNodeCount: 0,
      }),
    ).toBe("already-classic");
    expect(
      classifyRetirement({
        preferenceEnabled: false,
        classic: valid,
        lunora: valid,
        lunoraNodeCount: 1,
      }),
    ).toBe("backend-conflict");
  });

  it("distinguishes invalid classic, incomplete empty Lunora, and eligible", () => {
    expect(
      classifyRetirement({
        preferenceEnabled: true,
        classic: invalid,
        lunora: valid,
        lunoraNodeCount: 1,
      }),
    ).toBe("classic-invalid");
    expect(
      classifyRetirement({
        preferenceEnabled: true,
        classic: valid,
        lunora: invalid,
        lunoraNodeCount: 0,
      }),
    ).toBe("incomplete");
    expect(
      classifyRetirement({
        preferenceEnabled: true,
        classic: valid,
        lunora: valid,
        lunoraNodeCount: 1,
      }),
    ).toBe("eligible");
  });
});

it("uses a migration-specific prefix outside backup lifecycle", () => {
  expect(retirementSnapshotKey("u1", "m1", "classic")).toBe(
    "lunora-retirement/u1/m1/classic.json",
  );
});

it("builds a classic target without merging stale shared rows", () => {
  const lunora = snapshot([node("a", null, null), node("b", "a", null)]);
  const classic = {
    version: 1,
    exportedAt: 1,
    seq: 2,
    nodes: [node("old", null, null)],
    kv: [
      {
        collection: "account-prefs",
        key: "lunora-beta",
        value: '{"id":"lunora-beta","enabled":true}',
        updatedAt: 1,
      },
      {
        collection: "changelog",
        key: "cursor",
        value: '{"seq":7}',
        updatedAt: 2,
      },
      {
        collection: "daily-index",
        key: "stale",
        value: '{"key":"stale","nodeId":"old"}',
        updatedAt: 3,
      },
    ],
  };
  const target = buildClassicTarget(classic, lunora, 99);
  expect(target.nodes.map((row) => row.id)).toEqual(["a", "b"]);
  expect(target.kv.some((row) => row.collection === "changelog")).toBe(true);
  expect(target.kv.some((row) => row.key === "stale")).toBe(false);
  expect(target.kv.find((row) => row.key === "lunora-beta")?.value).toBe(
    '{"id":"lunora-beta","enabled":false}',
  );
  expect(
    target.kv.some(
      (row) => row.collection === "daily-index" && row.key === "today",
    ),
  ).toBe(true);
});
