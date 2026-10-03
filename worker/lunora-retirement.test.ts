import { describe, expect, it } from "bun:test";

import type { Node } from "../src/data/wire-schema";
import type { OutlineSnapshot } from "./backup";

import {
  buildClassicTarget,
  classicLinkRepairSourceHash,
  classifyRetirement,
  compareRetirementSnapshots,
  planClassicLinkRepair,
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

describe("read-only retirement comparison", () => {
  it("reports asymmetric differences and missing references without content or mutations", () => {
    const classic: OutlineSnapshot = {
      version: 1,
      exportedAt: 20,
      seq: 3,
      nodes: [
        node("r", null, null),
        node("p", "r", null),
        node("b", "p", null),
        node("s", null, "r"),
        node("x", null, "s"),
      ],
      kv: [
        {
          collection: "daily-index",
          key: "2024-01-01",
          value: '{"nodeId":"r","key":"2024-01-01"}',
          updatedAt: 1,
        },
        {
          collection: "daily-index",
          key: "2024-01-02",
          value: '{"key":"2024-01-02","nodeId":"x"}',
          updatedAt: 2,
        },
        {
          collection: "tag-colors",
          key: "SECRET_TAG",
          value: '{"color":"SECRET_COLOR","tag":"SECRET_TAG"}',
          updatedAt: 3,
        },
        {
          collection: "saved-queries",
          key: "q1",
          value:
            '{"query":"SECRET_QUERY","createdAt":1,"name":"SECRET_NAME","id":"q1"}',
          updatedAt: 4,
        },
      ],
    };
    const experimental = snapshot([
      node("r", null, null),
      { ...node("b", "p", null), text: "SECRET_TEXT", updatedAt: 99 },
      node("s", null, "r"),
      { ...node("e", null, "s"), mirrorOf: "lost-source" },
    ]);
    experimental.dailyIndex = [
      { key: "2024-01-01", nodeId: "b", touchedAt: 99, userId: "u1" },
      { key: "2024-01-03", nodeId: "e", touchedAt: 100, userId: "u1" },
    ];
    experimental.tagColors = [
      { tag: "SECRET_TAG", color: "SECRET_OTHER_COLOR", userId: "u1" },
    ];
    experimental.savedQueries = [
      {
        id: "q1",
        name: "SECRET_NAME",
        query: "SECRET_QUERY",
        createdAt: 1,
        userId: "u1",
      },
    ];
    const before = structuredClone({ classic, experimental });
    const report = compareRetirementSnapshots(classic, experimental);
    expect(report.consistency).toBe("unfrozen-snapshots");
    expect(report.nodes).toMatchObject({
      classic: 5,
      experimental: 4,
      shared: 3,
      identical: 2,
      classicOnly: { count: 2, sample: ["p", "x"] },
      experimentalOnly: { count: 1, sample: ["e"] },
      changed: {
        count: 1,
        sample: [{ nodeId: "b", fields: ["text", "updatedAt"] }],
      },
    });
    expect(report.graphs.experimental.missingReferences).toEqual({
      count: 2,
      truncated: false,
      sample: [
        {
          nodeId: "b",
          field: "parentId",
          referencedId: "p",
          presentInOtherBackend: true,
          nodePresentInOtherBackend: true,
          otherBackendReference: "p",
        },
        {
          nodeId: "e",
          field: "mirrorOf",
          referencedId: "lost-source",
          presentInOtherBackend: false,
          nodePresentInOtherBackend: false,
          otherBackendReference: null,
        },
      ],
    });
    expect(report.graphs.classic.validation).toEqual({ ok: true });
    expect(report.graphs.experimental.validation).toEqual({
      ok: false,
      reason: "node b has missing parent",
    });
    expect(report.sideCollections.dailyIndex).toMatchObject({
      classic: 2,
      experimental: 2,
      comparable: true,
      shared: 1,
      changed: 1,
      classicOnly: 1,
      experimentalOnly: 1,
    });
    expect(report.sideCollections.tagColors.changed).toBe(1);
    // Property order, export ownership, and KV write times do not change query content.
    expect(report.sideCollections.savedQueries.changed).toBe(0);
    expect(JSON.stringify(report)).not.toContain("SECRET_");
    expect({ classic, experimental }).toEqual(before);
  });

  it("marks malformed or duplicate side collections uncomparable without echoing values", () => {
    const classic: OutlineSnapshot = {
      version: 1,
      exportedAt: 1,
      seq: 1,
      nodes: [],
      kv: [
        {
          collection: "tag-colors",
          key: "SECRET_TAG",
          value: "{SECRET_VALUE",
          updatedAt: 1,
        },
        {
          collection: "tag-colors",
          key: "SECRET_TAG",
          value: '{"tag":"mismatch","color":"SECRET_COLOR"}',
          updatedAt: 2,
        },
      ],
    };
    const experimental = snapshot([node("a", null, null)]);
    experimental.tagColors = [
      { tag: "SECRET_TAG", color: "red", userId: "u1" },
      { tag: "SECRET_TAG", color: "blue", userId: "u1" },
    ];
    const report = compareRetirementSnapshots(classic, experimental);
    expect(report.sideCollections.tagColors).toEqual({
      classic: 2,
      experimental: 2,
      comparable: false,
      invalidClassicRows: 2,
      duplicateClassicKeys: true,
      duplicateExperimentalKeys: true,
      classicOnly: null,
      experimentalOnly: null,
      shared: null,
      changed: null,
    });
    expect(JSON.stringify(report)).not.toContain("SECRET_");
  });

  it("does not compare arbitrary winners when either backend has duplicate node ids", () => {
    const base = node("a", null, null);
    for (const backend of ["classic", "experimental"]) {
      const classic: OutlineSnapshot = {
        version: 1,
        exportedAt: 1,
        seq: 1,
        nodes:
          backend === "classic"
            ? [base, { ...base, text: "SECRET_OTHER_TEXT" }]
            : [base],
        kv: [],
      };
      const experimental = snapshot(
        backend === "experimental"
          ? [base, { ...base, text: "SECRET_OTHER_TEXT" }]
          : [base],
      );
      const report = compareRetirementSnapshots(classic, experimental);
      expect(report.nodes).toMatchObject({
        comparable: false,
        shared: null,
        identical: null,
        classicOnly: null,
        experimentalOnly: null,
        changed: null,
      });
      expect(JSON.stringify(report)).not.toContain("SECRET_");
    }
  });

  it("identifies a missing previous sibling and compares its counterpart reference", () => {
    const a = node("a", null, null);
    const b = node("b", null, "a");
    const classic: OutlineSnapshot = {
      version: 1,
      exportedAt: 1,
      seq: 1,
      nodes: [a, b],
      kv: [],
    };
    const report = compareRetirementSnapshots(classic, snapshot([b]));
    expect(report.graphs.experimental.missingReferences).toEqual({
      count: 1,
      truncated: false,
      sample: [
        {
          nodeId: "b",
          field: "prevSiblingId",
          referencedId: "a",
          presentInOtherBackend: true,
          nodePresentInOtherBackend: true,
          otherBackendReference: "a",
        },
      ],
    });
  });

  it("distinguishes disabled, absent, and malformed preferences", () => {
    const experimental = snapshot([node("a", null, null)]);
    for (const [value, expected] of [
      [null, "missing"],
      ['{"enabled":false}', "disabled"],
      ['{"enabled":true}', "enabled"],
      ['{"enabled":"false"}', "invalid"],
      ["{", "invalid"],
    ] as const) {
      const classic: OutlineSnapshot = {
        version: 1,
        exportedAt: 1,
        seq: 1,
        nodes: [],
        kv:
          value === null
            ? []
            : [
                {
                  collection: "account-prefs",
                  key: "lunora-beta",
                  value,
                  updatedAt: 1,
                },
              ],
      };
      expect(
        compareRetirementSnapshots(classic, experimental)
          .experimentalPreference,
      ).toBe(expected);
    }
  });

  it("bounds samples but counts every difference on both sides of the limit", () => {
    for (const count of [50, 51]) {
      const nodes = Array.from({ length: count }, (_, i) =>
        node(`n${i}`, null, i === 0 ? null : `n${i - 1}`),
      );
      const classic: OutlineSnapshot = {
        version: 1,
        exportedAt: 1,
        seq: 1,
        nodes,
        kv: [],
      };
      const experimental = snapshot([]);
      const report = compareRetirementSnapshots(classic, experimental);
      expect(report.nodes.classicOnly?.count).toBe(count);
      expect(report.nodes.classicOnly?.sample).toHaveLength(50);
      expect(report.nodes.classicOnly?.truncated).toBe(count > 50);
      experimental.nodes = nodes.map((row) => ({
        ...row,
        parentId: "missing",
        text: "SECRET_CHANGED_TEXT",
        userId: "u1",
      }));
      const changed = compareRetirementSnapshots(classic, experimental);
      expect(changed.nodes.changed?.count).toBe(count);
      expect(changed.nodes.changed?.sample).toHaveLength(50);
      expect(changed.nodes.changed?.truncated).toBe(count > 50);
      expect(changed.graphs.experimental.missingReferences.count).toBe(count);
      expect(changed.graphs.experimental.missingReferences.sample).toHaveLength(
        50,
      );
      expect(changed.graphs.experimental.missingReferences.truncated).toBe(
        count > 50,
      );
    }
  });
});

describe("explicit Classic link repair", () => {
  const classic = (nodes: Node[]): OutlineSnapshot => ({
    version: 1,
    exportedAt: 10,
    seq: 3,
    nodes,
    kv: [],
  });

  it("keeps existing root order and node payloads while rescuing a stranded subtree", () => {
    const orphan = {
      ...node("orphan", "deleted", null),
      text: "retain exactly",
      kind: "paragraph" as const,
      isTask: true,
      completed: true,
      updatedAt: 17,
    };
    const rows = [
      orphan,
      node("child", "orphan", null),
      node("root", null, null),
      node("tail", null, "root"),
      node("a", "root", null),
      node("b", "root", null),
    ];
    const plan = planClassicLinkRepair(classic(rows));
    expect(plan.nodes).toEqual(
      rows.map((row) =>
        row.id === "orphan"
          ? { ...row, parentId: null, prevSiblingId: "tail" }
          : row.id === "b"
            ? { ...row, prevSiblingId: "a" }
            : row,
      ),
    );
    expect(plan.summary).toEqual({ nodes: 6, parentLinks: 1, siblingLinks: 2 });
    expect(validateNodeGraph(plan.nodes)).toEqual({ ok: true });
    expect(rows[0]).toEqual(orphan);
  });

  it("repairs a sibling fan without discarding its losing branch", () => {
    const rows = [
      node("r", null, null),
      node("a", "r", null),
      node("b", "r", "a"),
      node("c", "r", "a"),
    ];
    const plan = planClassicLinkRepair(classic(rows));
    expect(plan.nodes).toEqual(
      rows.map((row) =>
        row.id === "c" ? { ...row, prevSiblingId: "b" } : row,
      ),
    );
    expect(plan.summary).toEqual({ nodes: 4, parentLinks: 0, siblingLinks: 1 });
  });

  it("rejects healthy graphs and anomalies outside the authorized link repair", () => {
    for (const rows of [
      [node("r", null, null)],
      [node("r", null, null), node("r", null, null)],
      [node("a", "b", null), node("b", "a", null)],
      [{ ...node("r", null, null), mirrorOf: "missing" }],
    ])
      expect(() => planClassicLinkRepair(classic(rows))).toThrow();
    const malformed = {
      ...classic([node("a", null, null), node("b", null, null)]),
      kv: [
        { collection: "daily-index", key: "day", value: "{}", updatedAt: 1 },
      ],
    };
    expect(() => planClassicLinkRepair(malformed)).toThrow();
  });

  it("binds identity, edits, side data and sequence, but not export clocks", async () => {
    const source = classic([node("a", null, null), node("b", null, null)]);
    const experimental = {
      ...snapshot([]),
      dailyIndex: [],
      tagColors: [],
      savedQueries: [],
      migrateState: [],
    };
    const hash = await classicLinkRepairSourceHash("u1", source, experimental);
    expect(
      await classicLinkRepairSourceHash(
        "u1",
        { ...source, exportedAt: 99 },
        { ...experimental, exportedAt: 87 },
      ),
    ).toBe(hash);
    for (const changed of [
      { ...source, seq: 4 },
      { ...source, nodes: source.nodes.map((n) => ({ ...n, text: "edited" })) },
      {
        ...source,
        kv: [{ collection: "prefs", key: "x", value: "false", updatedAt: 9 }],
      },
    ])
      expect(
        await classicLinkRepairSourceHash("u1", changed, experimental),
      ).not.toBe(hash);
    expect(
      await classicLinkRepairSourceHash("u2", source, experimental),
    ).not.toBe(hash);
  });
});
