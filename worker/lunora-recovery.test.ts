import { describe, expect, it } from "bun:test";

import type { Node } from "../src/data/wire-schema";
import type { OutlineSnapshot } from "./backup";
import type { LunoraRetirementSnapshot } from "./lunora-retirement";

import { planClassicRecovery } from "./lunora-recovery";
import { validateNodeGraph } from "./lunora-retirement";

const node = (id: string, fields: Partial<Node> = {}): Node => ({
  id,
  parentId: null,
  prevSiblingId: null,
  text: id,
  isTask: false,
  completed: false,
  collapsed: false,
  bookmarkedAt: null,
  mirrorOf: null,
  createdAt: 1,
  updatedAt: 2,
  origin: null,
  kind: null,
  ...fields,
});
const classic = (nodes: Node[]): OutlineSnapshot => ({
  version: 1,
  exportedAt: 100,
  seq: 7,
  nodes,
  kv: [
    {
      collection: "account-prefs",
      key: "lunora-beta",
      value: '{"enabled":false}',
      updatedAt: 99,
    },
  ],
});
const experimental = (nodes: Node[]): LunoraRetirementSnapshot => ({
  version: 1,
  exportedAt: 101,
  userId: "u1",
  nodes: nodes.map((row) => ({ ...row, userId: "u1" })),
  dailyIndex: [],
  tagColors: [],
  savedQueries: [],
  migrateState: [],
});
function plan(left: OutlineSnapshot, right: LunoraRetirementSnapshot) {
  let counter = 0;
  return planClassicRecovery(left, right, {
    userId: "u1",
    timestamp: 200,
    newId: () => `n_copy_${++counter}`,
  });
}
function copy(
  result: ReturnType<typeof plan>,
  id: string,
  contextOnly = false,
) {
  const entry = result.copies.find(
    (row) => row.sourceId === id && row.contextOnly === contextOnly,
  );
  const row = result.nodes.find((row) => row.id === entry?.copyId);
  if (!row) throw new Error(`missing test copy ${id}`);
  return row;
}

describe("preserve-Classic detached recovery plan", () => {
  it("separates meaningful alternatives from timestamps, structure and view metadata", () => {
    const children = [
      "text",
      "task",
      "completion",
      "kind",
      "time",
      "order",
      "view",
      "origin",
    ].map((id, index, ids) =>
      node(id, {
        parentId: "root",
        prevSiblingId: index === 0 ? null : (ids[index - 1] ?? null),
      }),
    );
    const left = classic([
      node("root"),
      ...children,
      node("classic-only", { prevSiblingId: "root" }),
    ]);
    const changed = new Map<string, Partial<Node>>([
      ["text", { text: "experimental version", updatedAt: 1 }], // Older clock still qualifies.
      ["task", { isTask: true }],
      ["completion", { completed: true }],
      ["kind", { kind: "paragraph" }],
      ["time", { updatedAt: 999 }],
      ["order", { prevSiblingId: null }],
      ["view", { collapsed: true, bookmarkedAt: 100 }],
      ["origin", { origin: "agent" }],
    ]);
    const right: LunoraRetirementSnapshot = {
      ...experimental([
        node("root"),
        ...children.map((row) => ({ ...row, ...changed.get(row.id) })),
        node("extra", {
          prevSiblingId: "root",
          text: "possibly deleted on Classic",
        }),
      ]),
      dailyIndex: [
        { key: "day", nodeId: "missing-day", touchedAt: 1, userId: "u1" },
      ],
      tagColors: [{ tag: "experimental-tag", color: "red", userId: "u1" }],
      savedQueries: [
        { id: "q", name: "Q", query: "is:todo", createdAt: 1, userId: "u1" },
      ],
    };
    const before = structuredClone({ left, right });
    const result = plan(left, right);
    expect(result.summary).toMatchObject({
      experimentalOnly: 1,
      substantiveAlternatives: 4,
      timestampOnly: 1,
      archiveOnlyDifferences: 3,
    });
    expect(result.summary.fieldDifferences).toEqual({
      id: 0,
      parentId: 0,
      prevSiblingId: 1,
      text: 1,
      isTask: 1,
      completed: 1,
      kind: 1,
      mirrorOf: 0,
      collapsed: 1,
      bookmarkedAt: 1,
      createdAt: 0,
      updatedAt: 2,
      origin: 1,
    });
    expect(
      result.copies
        .filter((row) => !row.contextOnly)
        .map((row) => row.sourceId)
        .sort(),
    ).toEqual(["completion", "extra", "kind", "task", "text"]);
    expect(copy(result, "text").text).toBe("experimental version");
    expect(copy(result, "task").isTask).toBe(true);
    expect(copy(result, "completion").completed).toBe(true);
    expect(copy(result, "kind").kind).toBe("paragraph");
    expect(
      result.nodes.every(
        (row) =>
          ![...left.nodes, ...right.nodes].some((old) => old.id === row.id),
      ),
    ).toBe(true);
    expect(result.nodes.every((row) => !("userId" in row))).toBe(true);
    expect(result).not.toHaveProperty("kv");
    expect(validateNodeGraph(result.nodes)).toEqual({ ok: true });
    expect({ left, right }).toEqual(before);
  });

  it("does not create a folder for timestamp-only and ordering-only differences", () => {
    const rows = [node("a"), node("b", { prevSiblingId: "a" })];
    const result = plan(
      classic(rows),
      experimental([
        { ...rows[0]!, updatedAt: 555, prevSiblingId: "b" },
        { ...rows[1]!, prevSiblingId: null },
      ]),
    );
    expect(result.rootId).toBeNull();
    expect(result.nodes).toEqual([]);
    expect(result.copies).toEqual([]);
    expect(result.summary.archiveOnlyDifferences).toBe(2);
  });

  it("prunes unrelated descendants and rebuilds order across unselected siblings", () => {
    const ancestor = node("parent", {
      isTask: true,
      completed: true,
      collapsed: true,
      bookmarkedAt: 10,
      kind: "paragraph",
    });
    const first = node("z-first", { parentId: "parent" });
    const skip = node("skip", { parentId: "parent", prevSiblingId: "z-first" });
    const last = node("a-last", { parentId: "parent", prevSiblingId: "skip" });
    const left = classic([ancestor, { ...skip, prevSiblingId: null }]);
    const right = experimental([last, skip, ancestor, first]); // Not storage or lexical order.
    const result = plan(left, right);
    const context = copy(result, "parent", true);
    expect(context.text).toBe("Context only, selected descendants: parent");
    expect(context).toMatchObject({
      isTask: false,
      completed: false,
      collapsed: false,
      bookmarkedAt: null,
      kind: null,
    });
    expect(result.copies.some((row) => row.sourceId === "skip")).toBe(false);
    expect(copy(result, "z-first")).toMatchObject({
      parentId: context.id,
      prevSiblingId: null,
    });
    expect(copy(result, "a-last")).toMatchObject({
      parentId: context.id,
      prevSiblingId: copy(result, "z-first").id,
    });
    expect(result.adaptations).toEqual([]);
    expect(validateNodeGraph(result.nodes)).toEqual({ ok: true });
    expect(plan(left, experimental([first, ancestor, skip, last]))).toEqual(
      result,
    );
  });

  it("adapts dangling parents, cycles and broken sibling chains in copies, never in the source", () => {
    const right = experimental([
      node("missing-child", { parentId: "absent-parent" }),
      node("cycle-b", { parentId: "cycle-a" }),
      node("cycle-a", { parentId: "cycle-b" }),
      node("fan-z"),
      node("fan-a"),
    ]);
    const before = structuredClone(right);
    const result = plan(classic([node("current")]), right);
    expect(result.copies.filter((row) => !row.contextOnly)).toHaveLength(5);
    expect(result.adaptations).toContainEqual({
      section: 0,
      nodeId: "missing-child",
      kind: "missing-parent",
    });
    expect(result.adaptations).toContainEqual({
      section: 0,
      nodeId: "cycle-a",
      kind: "parent-cycle",
    });
    expect(result.adaptations).toContainEqual({
      section: 0,
      nodeId: null,
      kind: "sibling-order",
    });
    expect(copy(result, "cycle-b").parentId).toBe(copy(result, "cycle-a").id);
    expect(validateNodeGraph(result.nodes)).toEqual({ ok: true });
    expect(right).toEqual(before);
  });

  it("does not borrow the missing experimental parent from Classic or copy Classic nodes", () => {
    const left = classic([
      node("retained"),
      node("child", { parentId: "retained" }),
    ]);
    const right = experimental([
      node("child", { parentId: "retained", text: "alternative" }),
    ]);
    const result = plan(left, right);
    expect(result.copies.map((row) => row.sourceId)).toEqual(["child"]);
    expect(result.adaptations).toContainEqual({
      section: 1,
      nodeId: "child",
      kind: "missing-parent",
    });
    expect(validateNodeGraph(result.nodes)).toEqual({ ok: true });
    expect(left.nodes[1]!.parentId).toBe("retained");
  });

  it("remaps forward links across sections but retains Classic, unresolved and external links", () => {
    const target = "n_alt_1",
      only = "n_extra_1",
      current = "n_current_1",
      absent = "n_absent_1";
    const left = classic([
      node(target),
      node(current, { prevSiblingId: target }),
    ]);
    const right = experimental([
      node(only, {
        text: `[[${target}]] [[${only}]] [[${current}]] [[${absent}]] https://app.dotflowy.com/${target} [[not an id]]`,
      }),
      node(target, { prevSiblingId: only, text: "alternative" }),
      node(current, { prevSiblingId: target }),
    ]);
    const result = plan(left, right);
    expect(copy(result, only).text).toBe(
      `[[${copy(result, target).id}]] [[${copy(result, only).id}]] [[${current}]] [[${absent}]] https://app.dotflowy.com/${target} [[not an id]]`,
    );
    expect(result.links).toEqual({ remapped: 2, classic: 1, unresolved: 1 });
  });

  it("keeps mirror locations inert, including changed shared mirrors and missing mirror sources", () => {
    const left = classic([node("root"), node("shared", { parentId: "root" })]);
    const right = experimental([
      node("root"),
      node("shared", { parentId: "root", mirrorOf: "missing" }),
      node("mirror", {
        parentId: "root",
        prevSiblingId: "shared",
        mirrorOf: "root",
        text: "stale mirror payload",
        isTask: true,
        completed: true,
      }),
    ]);
    const result = plan(left, right);
    expect(result.summary.substantiveAlternatives).toBe(1);
    for (const id of ["shared", "mirror"]) {
      expect(copy(result, id)).toMatchObject({
        mirrorOf: null,
        isTask: false,
        completed: false,
        kind: null,
      });
      expect(copy(result, id).text).toContain("Mirror reference:");
    }
    expect(result.nodes.every((row) => row.mirrorOf === null)).toBe(true);
    expect(validateNodeGraph(result.nodes)).toEqual({ ok: true });
  });

  it("rejects allocation collisions with retained claims, missing references and link targets", () => {
    const base = classic([node("classic-root", { text: "[[n_classic_1]]" })]);
    const left = {
      ...base,
      kv: [
        ...base.kv,
        {
          collection: "daily-index",
          key: "day",
          value: '{"key":"day","nodeId":"classic-claim"}',
          updatedAt: 1,
        },
      ],
    };
    const right: LunoraRetirementSnapshot = {
      ...experimental([
        node("experimental-root", {
          parentId: "absent-parent",
          prevSiblingId: "absent-sibling",
          mirrorOf: "absent-mirror",
          text: "[[n_experiment_1]]",
        }),
      ]),
      dailyIndex: [
        {
          key: "day",
          nodeId: "experimental-claim",
          touchedAt: 1,
          userId: "u1",
        },
      ],
    };
    for (const id of [
      "",
      "classic-root",
      "experimental-root",
      "classic-claim",
      "experimental-claim",
      "absent-parent",
      "absent-sibling",
      "absent-mirror",
      "n_classic_1",
      "n_experiment_1",
    ]) {
      expect(() =>
        planClassicRecovery(left, right, {
          userId: "u1",
          timestamp: 200,
          newId: () => id,
        }),
      ).toThrow("allocation collided");
    }
    expect(() =>
      planClassicRecovery(left, right, {
        userId: "u1",
        timestamp: 200,
        newId: () => "n_repeat_1",
      }),
    ).toThrow("allocation collided");
  });

  it("rejects wrong versions, duplicate nodes, ownership drift and invalid Classic", () => {
    const left = classic([node("current")]),
      right = experimental([node("extra")]);
    expect(() => plan({ ...left, version: 2 }, right)).toThrow(
      "version or ownership",
    );
    expect(() => plan(left, { ...right, version: 2 })).toThrow(
      "version or ownership",
    );
    expect(() => plan(left, { ...right, userId: "u2" })).toThrow(
      "version or ownership",
    );
    expect(() =>
      plan(left, { ...right, nodes: [...right.nodes, ...right.nodes] }),
    ).toThrow("duplicate experimental");
    for (const patch of [
      { nodes: [{ ...right.nodes[0]!, userId: "u2" }] },
      {
        dailyIndex: [
          { key: "d", nodeId: "absent", touchedAt: 1, userId: "u2" },
        ],
      },
      { tagColors: [{ tag: "work", color: "red", userId: "u2" }] },
      {
        savedQueries: [
          { id: "q", name: "Q", query: "is:todo", createdAt: 1, userId: "u2" },
        ],
      },
      { migrateState: [{ nodesAt: 1, kvAt: 1, userId: "u2" }] },
    ])
      expect(() => plan(left, { ...right, ...patch })).toThrow(
        "version or ownership",
      );
    expect(() =>
      plan(classic([node("broken", { parentId: "absent" })]), right),
    ).toThrow("valid Classic");
  });

  it("requires an explicit disabled preference, not missing, malformed or enabled", () => {
    const left = classic([node("current")]),
      right = experimental([node("extra")]);
    expect(() => plan({ ...left, kv: [] }, right)).toThrow(
      "explicitly disabled",
    );
    for (const value of ['{"enabled":true}', '{"enabled":"false"}', "{}"]) {
      expect(() =>
        plan({ ...left, kv: [{ ...left.kv[0]!, value }] }, right),
      ).toThrow("explicitly disabled");
    }
  });
});
