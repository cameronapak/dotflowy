import { describe, expect, it } from "bun:test";

import type { Node } from "../src/data/wire-schema";
import type { OutlineSnapshot } from "./backup";

import {
  buildClassicTarget,
  classifyRetirement,
  retirementSnapshotKey,
  validateClassicSnapshot,
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

  it("rejects missing watermarks and ownership drift", () => {
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
  });

  it("preserves retained day and scaffold claims when their nodes are absent", () => {
    const base = snapshot([node("a", null, null), node("b", "a", null)]);
    const dailyIndex = [
      { key: "2024-08-11", nodeId: "deleted-day", touchedAt: 7, userId: "u1" },
      {
        key: "container",
        nodeId: "undone-container",
        touchedAt: 9,
        userId: "u1",
      },
      ...base.dailyIndex,
    ];
    const lunora = { ...base, dailyIndex };
    const classic: OutlineSnapshot = {
      version: 1,
      exportedAt: 10,
      seq: 3,
      nodes: [node("old", null, null)],
      kv: [
        {
          collection: "daily-index",
          key: "2024-02-12",
          value: '{ "key": "2024-02-12", "nodeId": "deleted-classic-day" }',
          updatedAt: 4,
        },
      ],
    };
    const before = structuredClone({ classic, lunora });
    expect(validateClassicSnapshot(classic)).toEqual({ ok: true });
    expect(validateLunoraSnapshot(lunora, "u1")).toEqual({ ok: true });
    const target = buildClassicTarget(classic, lunora, 99);
    expect(target.nodes.map((row) => row.id)).toEqual(["a", "b"]);
    expect(target.kv.filter((row) => row.collection === "daily-index")).toEqual(
      [
        {
          collection: "daily-index",
          key: "2024-08-11",
          value: '{"key":"2024-08-11","nodeId":"deleted-day"}',
          updatedAt: 7,
        },
        {
          collection: "daily-index",
          key: "container",
          value: '{"key":"container","nodeId":"undone-container"}',
          updatedAt: 9,
        },
        {
          collection: "daily-index",
          key: "today",
          value: '{"key":"today","nodeId":"b"}',
          updatedAt: 2,
        },
      ],
    );
    expect(validateClassicSnapshot({ ...classic, ...target })).toEqual({
      ok: true,
    });
    expect({ classic, lunora }).toEqual(before);
  });

  it("still rejects malformed and duplicate classic daily claims", () => {
    const row = {
      collection: "daily-index",
      key: "2024-08-11",
      value: '{"key":"2024-08-11","nodeId":"absent"}',
      updatedAt: 1,
    };
    const classic: OutlineSnapshot = {
      version: 1,
      exportedAt: 1,
      seq: 1,
      nodes: [node("a", null, null)],
      kv: [row],
    };
    for (const value of [
      "{",
      '{"key":"2024-08-11","nodeId":5}',
      '{"key":"wrong","nodeId":"absent"}',
    ]) {
      expect(
        validateClassicSnapshot({ ...classic, kv: [{ ...row, value }] }).ok,
      ).toBe(false);
    }
    expect(validateClassicSnapshot({ ...classic, kv: [row, row] })).toEqual({
      ok: false,
      reason: "classic snapshot has duplicate kv keys",
    });
    expect(
      validateClassicSnapshot({
        ...classic,
        nodes: [node("a", "missing", null)],
      }),
    ).toEqual({ ok: false, reason: "node a has missing parent" });
  });

  it("still rejects duplicate and foreign retained Lunora claims and broken node references", () => {
    const base = snapshot([node("a", null, null), node("b", "a", null)]);
    const claim = {
      key: "2024-08-11",
      nodeId: "absent",
      touchedAt: 2,
      userId: "u1",
    };
    expect(
      validateLunoraSnapshot({ ...base, dailyIndex: [claim, claim] }, "u1"),
    ).toEqual({ ok: false, reason: "duplicate daily key 2024-08-11" });
    expect(
      validateLunoraSnapshot(
        { ...base, dailyIndex: [{ ...claim, userId: "u2" }] },
        "u1",
      ),
    ).toEqual({ ok: false, reason: "Lunora row ownership mismatch" });
    expect(
      validateLunoraSnapshot(
        {
          ...base,
          dailyIndex: [claim],
          nodes: [{ ...base.nodes[0]!, mirrorOf: "missing" }, base.nodes[1]!],
        },
        "u1",
      ),
    ).toEqual({ ok: false, reason: "node a has missing mirror source" });
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
