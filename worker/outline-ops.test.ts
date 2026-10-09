/**
 * The server-side outline planners (worker/outline-ops.ts): pure snapshot ->
 * ChangeOp-batch logic, the Worker twin of the client's mutations. Unit-tested
 * here because the chain surgery (insert repoints, cascade delete relinks,
 * mirror flatten/cycle rules, daily materialization) is exactly the kind of
 * pure logic bun test owns — e2e can't reach it (the MCP endpoint has no
 * browser caller). Fixtures use `createNode()` (tree.ts), the canonical builder.
 */

import { describe, expect, test } from "bun:test";

import type { ChangeOp, Node } from "../src/data/wire-schema";

import { weekLabel } from "../src/data/date-links";
import { exportOpml } from "../src/data/opml-export";
import { createNode } from "../src/data/tree";
import {
  BatchTooLarge,
  EmptyForest,
  MirrorCycle,
  NodeNotFound,
  RedundantDescendant,
  WouldCycle,
  WouldOrphanMirrors,
  buildTreeIndex,
  flattenSubtree,
  formatDayText,
  formatOutlineLines,
  planAddNode,
  planAddSubtree,
  planAddSubtreeToDaily,
  planAddToDaily,
  planDeleteNode,
  planEnsureDaily,
  planMirrorNode,
  planMirrorToDaily,
  planReparent,
  planUpdateNode,
  redactSpoilerIndex,
} from "./outline-ops";

const T = 1_700_000_000_000;

/** a -> b (top level), with a1 -> a2 under a. */
function fixture(): Node[] {
  return [
    createNode({ id: "a", text: "alpha" }),
    createNode({ id: "b", text: "bravo", prevSiblingId: "a" }),
    createNode({ id: "a1", text: "alpha one", parentId: "a" }),
    createNode({
      id: "a2",
      text: "alpha two",
      parentId: "a",
      prevSiblingId: "a1",
    }),
  ];
}

function index(nodes: Node[]) {
  return buildTreeIndex(nodes);
}

/** Scaffold ids for the daily planners (issue #271): one distinct node id per
 *  calendar level, plus the daily-index reverse map (nodeId -> scaffold key)
 *  that drives sorted sibling insertion. An empty map = a fresh Daily subtree
 *  with no siblings to order against. Override individual ids to match an
 *  existing-node fixture. */
function scaffold(
  keyByNodeId: ReadonlyMap<string, string> = new Map(),
  ids: Partial<{
    containerId: string;
    yearId: string;
    monthId: string;
    weekId: string;
    dayId: string;
  }> = {},
) {
  return {
    containerId: "cont",
    yearId: "yr",
    monthId: "mo",
    weekId: "wk",
    dayId: "day",
    ...ids,
    keyByNodeId,
  };
}

function inserted(ops: ChangeOp[]): Node[] {
  return ops.flatMap((op) => (op.op === "insert" ? [op.value] : []));
}

function updated(ops: ChangeOp[]): Node[] {
  return ops.flatMap((op) => (op.op === "update" ? [op.value] : []));
}

function deletedKeys(ops: ChangeOp[]): string[] {
  return ops.flatMap((op) => (op.op === "delete" ? [op.key] : []));
}

describe("planAddNode", () => {
  /** Plan one add into the shared fixture with defaults callers override. */
  const add = (
    overrides: Partial<Parameters<typeof planAddNode>[1]>,
    nodes: Node[] = fixture(),
  ) =>
    planAddNode(index(nodes), {
      id: "new",
      text: "x",
      parentId: "a",
      position: "last",
      isTask: false,
      timestamp: T,
      ...overrides,
    });

  test("places, redirects, stamps, and normalizes the created node", () => {
    // Appending as the last child repoints nobody.
    const last = add({});
    if (last instanceof Error) throw last;
    expect(last.ops).toHaveLength(1);
    const appended = inserted(last.ops)[0]!;
    expect(appended.parentId).toBe("a");
    expect(appended.prevSiblingId).toBe("a2");
    // Omitting origin (a non-MCP caller) defaults to null: human-authored.
    expect(appended.origin).toBeNull();
    // Omitting kind defaults to a plain bullet.
    expect(appended.kind).toBeNull();

    // Inserting first repoints the old head.
    const first = add({ position: "first", isTask: true });
    if (first instanceof Error) throw first;
    expect(inserted(first.ops)[0]!.prevSiblingId).toBeNull();
    expect(inserted(first.ops)[0]!.isTask).toBe(true);
    expect(updated(first.ops)[0]!.id).toBe("a1");
    expect(updated(first.ops)[0]!.prevSiblingId).toBe("new");

    // A null parent adds at the top level after the last root.
    const top = add({ parentId: null });
    if (top instanceof Error) throw top;
    expect(inserted(top.ops)[0]!.parentId).toBeNull();
    expect(inserted(top.ops)[0]!.prevSiblingId).toBe("b");

    // A mirror parent redirects to its true source.
    const viaMirror = add({ parentId: "m" }, [
      ...fixture(),
      createNode({ id: "m", text: "alpha", mirrorOf: "a", prevSiblingId: "b" }),
    ]);
    if (viaMirror instanceof Error) throw viaMirror;
    expect(inserted(viaMirror.ops)[0]!.parentId).toBe("a");

    // The MCP write path passes the caller's harness name; the created node
    // carries it verbatim (write-once).
    const agent = add({ origin: "Claude" });
    if (agent instanceof Error) throw agent;
    expect(inserted(agent.ops)[0]!.origin).toBe("Claude");

    // A paragraph is never a task (ADR 0045).
    const prose = add({ isTask: true, kind: "paragraph" });
    if (prose instanceof Error) throw prose;
    expect(inserted(prose.ops)[0]!.kind).toBe("paragraph");
    expect(inserted(prose.ops)[0]!.isTask).toBe(false);

    expect(add({ parentId: "ghost" })).toBeInstanceOf(NodeNotFound);
  });
});

describe("planUpdateNode", () => {
  test("merges field changes into one update, routing mirror content to the source", () => {
    const plan = planUpdateNode(index(fixture()), {
      nodeId: "a1",
      changes: { text: "renamed", completed: true },
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    expect(plan.ops).toHaveLength(1);
    const node = updated(plan.ops)[0]!;
    expect(node.text).toBe("renamed");
    expect(node.completed).toBe(true);
    expect(node.updatedAt).toBe(T);

    // Content fields on a mirror land on the source; collapsed stays local.
    const nodes = [
      ...fixture(),
      createNode({ id: "m", text: "alpha", mirrorOf: "a", prevSiblingId: "b" }),
    ];
    const mirrored = planUpdateNode(index(nodes), {
      nodeId: "m",
      changes: { text: "shared edit", collapsed: true },
      timestamp: T,
    });
    if (mirrored instanceof Error) throw mirrored;
    const byId = new Map(updated(mirrored.ops).map((n) => [n.id, n]));
    expect(byId.get("a")?.text).toBe("shared edit");
    expect(byId.get("m")?.collapsed).toBe(true);
    // The mirror's own text is untouched (display snapshot; reads resolve live).
    expect(byId.get("m")?.text).toBe("alpha");

    expect(
      planUpdateNode(index(fixture()), {
        nodeId: "ghost",
        changes: { text: "x" },
        timestamp: T,
      }),
    ).toBeInstanceOf(NodeNotFound);
  });

  // Kind exclusivity at the trust boundary (ADR 0045): the server normalizes the
  // pair exactly as the client funnels do, so no agent can persist an illegal one.
  test.each([
    [
      "kind=paragraph clears isTask",
      { isTask: true },
      { kind: "paragraph" },
      "paragraph",
      false,
    ],
    ["isTask clears kind", { kind: "paragraph" }, { isTask: true }, null, true],
    [
      "kind wins when both are passed",
      {},
      { isTask: true, kind: "paragraph" },
      "paragraph",
      false,
    ],
    [
      "kind=null turns a paragraph back into a bullet",
      { kind: "paragraph" },
      { kind: null },
      null,
      false,
    ],
  ] as const)("%s", (_name, start, changes, kind, isTask) => {
    const nodes = [createNode({ id: "n", text: "x", ...start })];
    const plan = planUpdateNode(index(nodes), {
      nodeId: "n",
      changes,
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const node = updated(plan.ops)[0]!;
    expect(node.kind).toBe(kind);
    expect(node.isTask).toBe(isTask);
  });
});

describe("planDeleteNode", () => {
  test("cascades the subtree, repoints the follower, and guards mirrors", () => {
    const plan = planDeleteNode(index(fixture()), "a", T);
    if (plan instanceof Error) throw plan;
    expect(new Set(deletedKeys(plan.ops))).toEqual(new Set(["a", "a1", "a2"]));
    const repointed = updated(plan.ops)[0]!;
    expect(repointed.id).toBe("b");
    expect(repointed.prevSiblingId).toBeNull();

    const nodes = [
      ...fixture(),
      createNode({ id: "a11", text: "alpha child", parentId: "a1" }),
      createNode({
        id: "m",
        text: "alpha one",
        mirrorOf: "a1",
        prevSiblingId: "b",
      }),
    ];
    // The subtree has a surviving mirror elsewhere: refuse.
    expect(planDeleteNode(index(nodes), "a", T)).toBeInstanceOf(
      WouldOrphanMirrors,
    );
    // Deleting the mirror itself is safe and touches only the mirror.
    const mirror = planDeleteNode(index(nodes), "m", T);
    if (mirror instanceof Error) throw mirror;
    expect(deletedKeys(mirror.ops)).toEqual(["m"]);
  });
});

describe("planMirrorNode", () => {
  test("mirrors as the last child, flattening mirror-of-mirror, and refuses a cycle", () => {
    const nodes = [
      ...fixture(),
      createNode({
        id: "m",
        text: "alpha one",
        mirrorOf: "a1",
        prevSiblingId: "b",
      }),
    ];
    const plan = planMirrorNode(index(nodes), {
      sourceId: "m",
      targetParentId: "b",
      id: "mm",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const node = inserted(plan.ops)[0]!;
    expect(node.mirrorOf).toBe("a1");
    expect(node.parentId).toBe("b");
    expect(plan.sourceId).toBe("a1");

    // Mirroring a node into its own subtree is refused.
    expect(
      planMirrorNode(index(fixture()), {
        sourceId: "a",
        targetParentId: "a1",
        id: "mm",
        timestamp: T,
      }),
    ).toBeInstanceOf(MirrorCycle);
  });
});

describe("planReparent", () => {
  const move = (nodes: Node[], args: Parameters<typeof planReparent>[1]) =>
    planReparent(index(nodes), args);

  /** The emitted update ops, keyed by node id. */
  const movedById = (ops: ChangeOp[]) =>
    new Map(updated(ops).map((n) => [n.id, n]));

  test("moves one node last, first, to the top level, and through a mirror parent", () => {
    const last = move(fixture(), {
      nodeIds: ["b"],
      newParentId: "a",
      position: "last",
      timestamp: T,
    });
    if (last instanceof Error) throw last;
    const b = movedById(last.ops).get("b")!;
    expect(b.parentId).toBe("a");
    expect(b.prevSiblingId).toBe("a2");
    expect(b.updatedAt).toBe(T);
    expect(last.parentId).toBe("a");
    expect(last.movedIds).toEqual(["b"]);

    // "first" pushes the old head down.
    const first = move(fixture(), {
      nodeIds: ["b"],
      newParentId: "a",
      position: "first",
      timestamp: T,
    });
    if (first instanceof Error) throw first;
    expect(movedById(first.ops).get("b")!.prevSiblingId).toBeNull();
    expect(movedById(first.ops).get("a1")!.prevSiblingId).toBe("b");

    // A null parent moves to the top level after the last root, and the
    // follower under the old parent inherits the moved node's old predecessor.
    const top = move(fixture(), {
      nodeIds: ["a1"],
      newParentId: null,
      position: "last",
      timestamp: T,
    });
    if (top instanceof Error) throw top;
    expect(movedById(top.ops).get("a1")!.parentId).toBeNull();
    expect(movedById(top.ops).get("a1")!.prevSiblingId).toBe("b");
    expect(movedById(top.ops).get("a2")!.prevSiblingId).toBeNull();

    // A mirror parent redirects to its true source.
    const viaMirror = move(
      [
        ...fixture(),
        createNode({
          id: "m",
          text: "alpha",
          mirrorOf: "a",
          prevSiblingId: "b",
        }),
      ],
      { nodeIds: ["b"], newParentId: "m", position: "last", timestamp: T },
    );
    if (viaMirror instanceof Error) throw viaMirror;
    expect(viaMirror.parentId).toBe("a");
    expect(movedById(viaMirror.ops).get("b")!.parentId).toBe("a");

    // Repeated ids are deduplicated, preserving first-seen order.
    const dup = move(fixture(), {
      nodeIds: ["b", "b"],
      newParentId: "a",
      position: "last",
      timestamp: T,
    });
    if (dup instanceof Error) throw dup;
    expect(dup.movedIds).toEqual(["b"]);
  });

  test("a run of mutual siblings keeps its chain at the tail and at the head", () => {
    // Both a1 and a2 are children of a; moving both under b must not self-ref or
    // reorder: the bug the rebuild-between-moves guard exists to prevent.
    const tail = move(fixture(), {
      nodeIds: ["a1", "a2"],
      newParentId: "b",
      position: "last",
      timestamp: T,
    });
    if (tail instanceof Error) throw tail;
    const byId = movedById(tail.ops);
    expect(byId.get("a1")!.parentId).toBe("b");
    expect(byId.get("a1")!.prevSiblingId).toBeNull();
    expect(byId.get("a2")!.parentId).toBe("b");
    expect(byId.get("a2")!.prevSiblingId).toBe("a1");

    const nodes = [
      createNode({ id: "p", text: "parent" }),
      createNode({ id: "z", text: "z", parentId: "p" }),
      createNode({ id: "x", text: "x", prevSiblingId: "p" }),
      createNode({ id: "y", text: "y", prevSiblingId: "x" }),
    ];
    const head = move(nodes, {
      nodeIds: ["x", "y"],
      newParentId: "p",
      position: "first",
      timestamp: T,
    });
    if (head instanceof Error) throw head;
    const headById = movedById(head.ops);
    expect(headById.get("x")!.prevSiblingId).toBeNull();
    expect(headById.get("y")!.prevSiblingId).toBe("x");
    // The pre-existing child is pushed below the moved run.
    expect(headById.get("z")!.prevSiblingId).toBe("y");
  });

  test("moves across different parents in one call, emitting only updates (ADR 0027)", () => {
    // a1 (under a) and b (top level) both land under a2.
    const plan = move(fixture(), {
      nodeIds: ["a1", "b"],
      newParentId: "a2",
      position: "last",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const byId = movedById(plan.ops);
    expect(byId.get("a1")!.parentId).toBe("a2");
    expect(byId.get("a1")!.prevSiblingId).toBeNull();
    expect(byId.get("b")!.parentId).toBe("a2");
    expect(byId.get("b")!.prevSiblingId).toBe("a1");
    // A move never recreates a node.
    expect(plan.ops.every((op) => op.op === "update")).toBe(true);
  });

  test.each([
    ["a missing node", ["ghost"], "a", NodeNotFound],
    ["a missing parent", ["a1"], "ghost", NodeNotFound],
    ["a node under itself", ["a"], "a", WouldCycle],
    ["a node under its own descendant", ["a"], "a1", WouldCycle],
    [
      "a node alongside its own moved ancestor",
      ["a", "a1"],
      "b",
      RedundantDescendant,
    ],
  ] as const)("refuses %s", (_name, nodeIds, newParentId, error) => {
    expect(
      move(fixture(), {
        nodeIds: [...nodeIds],
        newParentId,
        position: "last",
        timestamp: T,
      }),
    ).toBeInstanceOf(error);
  });
});

describe("planAddSubtree", () => {
  /** A deterministic id factory: n0, n1, n2, ... in emission order. */
  const idFactory = () => {
    let i = 0;
    return () => `n${i++}`;
  };

  /** Plan a forest with defaults callers override. */
  const addForest = (
    nodes: Node[],
    overrides: Partial<Parameters<typeof planAddSubtree>[1]>,
  ) =>
    planAddSubtree(index(nodes), {
      nodes: [{ text: "x" }],
      parentId: "a",
      position: "last",
      timestamp: T,
      newId: idFactory(),
      maxNodes: 500,
      ...overrides,
    });

  test("wires a run of sibling roots into one unbroken chain (the trap)", () => {
    // Three top-level roots under `a`: looping planAddNode over a stale index
    // would give each the same prevSiblingId (a2) and tear the chain. By
    // construction each root chains to the previous one.
    const plan = addForest(fixture(), {
      nodes: [{ text: "one" }, { text: "two" }, { text: "three" }],
    });
    if (plan instanceof Error) throw plan;
    const nodes = inserted(plan.ops);
    expect(nodes.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);
    expect(nodes.map((n) => n.parentId)).toEqual(["a", "a", "a"]);
    // First root chains after the parent's existing last child (a2), the rest
    // chain to their predecessor: no shared predecessor, no self-ref.
    expect(nodes.map((n) => n.prevSiblingId)).toEqual(["a2", "n0", "n1"]);
    expect(plan.rootIds).toEqual(["n0", "n1", "n2"]);
    expect(plan.parentId).toBe("a");
  });

  test("nests children depth-first, carrying origin and kind on every node", () => {
    const plan = addForest([], {
      nodes: [
        {
          text: "root",
          children: [
            {
              text: "c1",
              kind: "paragraph",
              children: [{ text: "g1" }, { text: "g2", isTask: true }],
            },
            { text: "c2" },
          ],
        },
      ],
      parentId: null,
      origin: "Claude",
    });
    if (plan instanceof Error) throw plan;
    const byId = new Map(inserted(plan.ops).map((n) => [n.id, n]));
    // n0 root, n1 c1, n2 g1, n3 g2, n4 c2  (depth-first emission order)
    expect(byId.get("n0")!.parentId).toBeNull();
    expect(byId.get("n0")!.prevSiblingId).toBeNull();
    expect(byId.get("n1")!.parentId).toBe("n0");
    expect(byId.get("n1")!.prevSiblingId).toBeNull();
    expect(byId.get("n2")!.parentId).toBe("n1");
    expect(byId.get("n2")!.prevSiblingId).toBeNull();
    expect(byId.get("n3")!.parentId).toBe("n1");
    expect(byId.get("n3")!.prevSiblingId).toBe("n2");
    // c2 is the root's second child, chaining after c1
    expect(byId.get("n4")!.parentId).toBe("n0");
    expect(byId.get("n4")!.prevSiblingId).toBe("n1");
    expect(plan.rootIds).toEqual(["n0"]);

    // Every authored node, root and descendant, carries the caller's origin.
    expect([...byId.values()].every((n) => n.origin === "Claude")).toBe(true);
    // Kind is per node: only c1 is a paragraph; g2 stays a task bullet.
    expect(byId.get("n0")!.kind).toBeNull();
    expect(byId.get("n1")!.kind).toBe("paragraph");
    expect(byId.get("n3")!.kind).toBeNull();
    expect(byId.get("n3")!.isTask).toBe(true);
  });

  test('position "first" puts the run at the head and repoints the old head to the run tail', () => {
    const plan = addForest(fixture(), {
      nodes: [{ text: "one" }, { text: "two" }],
      position: "first",
    });
    if (plan instanceof Error) throw plan;
    const inserts = inserted(plan.ops);
    expect(inserts[0]!.prevSiblingId).toBeNull();
    expect(inserts[1]!.prevSiblingId).toBe("n0");
    // a's former first child (a1) now follows the LAST root of the run (n1)
    const repointed = updated(plan.ops);
    expect(repointed).toHaveLength(1);
    expect(repointed[0]!.id).toBe("a1");
    expect(repointed[0]!.prevSiblingId).toBe("n1");
  });

  test("a mirror parent redirects to its true source", () => {
    const plan = addForest(
      [
        ...fixture(),
        createNode({
          id: "m",
          text: "alpha",
          mirrorOf: "a",
          prevSiblingId: "b",
        }),
      ],
      { parentId: "m" },
    );
    if (plan instanceof Error) throw plan;
    expect(inserted(plan.ops)[0]!.parentId).toBe("a");
    expect(plan.parentId).toBe("a");
  });

  const refusals: Array<
    [
      string,
      Partial<Parameters<typeof planAddSubtree>[1]>,
      new (...args: never[]) => Error,
    ]
  > = [
    ["an empty forest", { nodes: [] }, EmptyForest],
    // 1 root + 2 children = 3 nodes; descendants count against a cap of 2.
    [
      "a forest over the cap",
      {
        nodes: [{ text: "r", children: [{ text: "a" }, { text: "b" }] }],
        maxNodes: 2,
      },
      BatchTooLarge,
    ],
    ["a missing parent", { parentId: "ghost" }, NodeNotFound],
  ];
  test.each(refusals)("refuses %s", (_name, overrides, error) => {
    expect(addForest(fixture(), overrides)).toBeInstanceOf(error);
  });

  test("planAddSubtreeToDaily appends after the day's last child, materializing a missing day", () => {
    const existing = planAddSubtreeToDaily(
      index([
        ...fixture(),
        createNode({ id: "cont", text: "Daily", prevSiblingId: "b" }),
        createNode({
          id: "day",
          text: "Friday, July 3, 2026",
          parentId: "cont",
        }),
        createNode({ id: "existing", text: "already here", parentId: "day" }),
      ]),
      {
        nodes: [{ text: "one" }, { text: "two" }],
        dateKey: "2026-07-03",
        ...scaffold(),
        timestamp: T,
        newId: idFactory(),
        maxNodes: 500,
      },
    );
    if (existing instanceof Error) throw existing;
    const inserts = inserted(existing.ops);
    expect(inserts.map((n) => n.parentId)).toEqual(["day", "day"]);
    expect(inserts[0]!.prevSiblingId).toBe("existing");
    expect(inserts[1]!.prevSiblingId).toBe(inserts[0]!.id);
    expect(existing.rootIds).toHaveLength(2);

    // With no Daily subtree yet, the whole calendar chain is minted first.
    const fresh = planAddSubtreeToDaily(index(fixture()), {
      nodes: [{ text: "one" }],
      dateKey: "2026-07-03",
      ...scaffold(),
      timestamp: T,
      newId: idFactory(),
      maxNodes: 500,
    });
    if (fresh instanceof Error) throw fresh;
    const ids = inserted(fresh.ops).map((n) => n.id);
    for (const id of ["cont", "yr", "mo", "wk", "day"])
      expect(ids).toContain(id);
    const entry = inserted(fresh.ops).find((n) => n.id === fresh.rootIds[0])!;
    expect(entry.parentId).toBe("day");
    expect(entry.prevSiblingId).toBeNull();
  });
});

describe("daily planning", () => {
  /** A seeded `Daily > 2026 > July > Week N` chain (ids cont/yr/mo/wk) plus its
   *  reverse map, ready for a same-week day insert. `weekLabel` keeps the seeded
   *  week text honest against the scaffold key. */
  function seededWeek(weekKey: string, extraDays: Node[] = []) {
    const nodes = [
      ...fixture(),
      createNode({
        id: "cont",
        text: "Daily",
        prevSiblingId: "b",
      }),
      createNode({ id: "yr", text: "2026", parentId: "cont" }),
      createNode({ id: "mo", text: "July", parentId: "yr" }),
      createNode({ id: "wk", text: weekLabel(weekKey), parentId: "mo" }),
      ...extraDays,
    ];
    const rev = new Map<string, string>([
      ["cont", "container"],
      ["yr", "2026"],
      ["mo", "2026-07"],
      ["wk", weekKey],
    ]);
    return { nodes, rev };
  }

  test("first use builds the whole Daily > Year > Month > Week > Day chain", () => {
    const plan = planEnsureDaily(index(fixture()), {
      dateKey: "2026-07-03",
      ...scaffold(),
      timestamp: T,
    });
    const nodes = inserted(plan.ops);
    // Top-down emission order, one node per level.
    expect(nodes.map((n) => n.id)).toEqual(["cont", "yr", "mo", "wk", "day"]);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("cont")!.parentId).toBeNull();
    expect(byId.get("cont")!.prevSiblingId).toBe("b");
    expect(byId.get("cont")!.text).toBe("Daily");
    expect(byId.get("yr")!.parentId).toBe("cont");
    expect(byId.get("yr")!.text).toBe("2026");
    expect(byId.get("mo")!.parentId).toBe("yr");
    expect(byId.get("mo")!.text).toBe("July");
    expect(byId.get("wk")!.parentId).toBe("mo");
    expect(byId.get("wk")!.text).toBe("Jun 29–Jul 5");
    expect(byId.get("day")!.parentId).toBe("wk");
    expect(byId.get("day")!.prevSiblingId).toBeNull();
    expect(byId.get("day")!.text).toBe("Friday, July 3, 2026");
  });

  test("a second day in the same week reuses year/month/week, only minting the day", () => {
    // 2026-07-13 and 2026-07-16 are in the same Monday-start week.
    const { nodes, rev } = seededWeek("week:2026-07-13", [
      createNode({ id: "d13", text: "Monday, July 13, 2026", parentId: "wk" }),
    ]);
    rev.set("d13", "2026-07-13");
    const plan = planEnsureDaily(index(nodes), {
      dateKey: "2026-07-16",
      ...scaffold(rev, { dayId: "d16" }),
      timestamp: T,
    });
    const inserts = inserted(plan.ops);
    // ONLY the day is minted; the existing Y/M/W are reused.
    expect(inserts.map((n) => n.id)).toEqual(["d16"]);
    expect(inserts[0]!.parentId).toBe("wk");
    // 07-16 sorts AFTER 07-13, so it chains from it (nothing to repoint).
    expect(inserts[0]!.prevSiblingId).toBe("d13");
    expect(updated(plan.ops)).toHaveLength(0);
  });

  test("a later day lands AHEAD of a trailing non-scaffold sibling under its week (finding 9)", () => {
    // The week holds a day plus a stray bullet (outdented under it, decision 9,
    // no daily-index mapping). A newer day chains after the last DAY, NOT past
    // the trailing bullet at the absolute tail — the shared placement decision.
    const { nodes, rev } = seededWeek("week:2026-07-13", [
      createNode({ id: "d13", text: "Monday, July 13, 2026", parentId: "wk" }),
      createNode({
        id: "note",
        text: "stray",
        parentId: "wk",
        prevSiblingId: "d13",
      }),
    ]);
    rev.set("d13", "2026-07-13"); // `note` intentionally has no mapping
    const plan = planEnsureDaily(index(nodes), {
      dateKey: "2026-07-16",
      ...scaffold(rev, { dayId: "d16" }),
      timestamp: T,
    });
    const inserts = inserted(plan.ops);
    expect(inserts.map((n) => n.id)).toEqual(["d16"]);
    expect(inserts[0]!.prevSiblingId).toBe("d13"); // after the last DAY
    // The trailing bullet is repointed to follow the new day (not left dangling).
    const repointed = updated(plan.ops).find((n) => n.id === "note");
    expect(repointed?.prevSiblingId).toBe("d16");
  });

  test("an out-of-order EARLIER day inserts BEFORE its later sibling (ascending)", () => {
    // The week already holds 07-16; ensuring 07-13 must land before it — retiring
    // the old "past day lands on top" caveat (decision 4).
    const { nodes, rev } = seededWeek("week:2026-07-13", [
      createNode({
        id: "d16",
        text: "Thursday, July 16, 2026",
        parentId: "wk",
      }),
    ]);
    rev.set("d16", "2026-07-16");
    const plan = planEnsureDaily(index(nodes), {
      dateKey: "2026-07-13",
      ...scaffold(rev, { dayId: "d13" }),
      timestamp: T,
    });
    const inserts = inserted(plan.ops);
    expect(inserts.map((n) => n.id)).toEqual(["d13"]);
    expect(inserts[0]!.prevSiblingId).toBeNull(); // new head of the week
    // The later day is repointed to follow the earlier one.
    const repointed = updated(plan.ops)[0]!;
    expect(repointed.id).toBe("d16");
    expect(repointed.prevSiblingId).toBe("d13");
  });

  test("years sort ascending under the container; a later year appends after an earlier one", () => {
    const nodes = [
      createNode({ id: "cont", text: "Daily" }),
      createNode({ id: "yr25", text: "2025", parentId: "cont" }),
    ];
    const rev = new Map<string, string>([
      ["cont", "container"],
      ["yr25", "2025"],
    ]);
    const plan = planEnsureDaily(index(nodes), {
      dateKey: "2026-07-03",
      ...scaffold(rev),
      timestamp: T,
    });
    const byId = new Map(inserted(plan.ops).map((n) => [n.id, n]));
    expect(byId.get("yr")!.parentId).toBe("cont");
    expect(byId.get("yr")!.prevSiblingId).toBe("yr25"); // 2026 after 2025
    expect(updated(plan.ops)).toHaveLength(0); // appended, nothing repointed
  });

  test("the fourth-day rule places a late-December week in the next year", () => {
    // The week of Monday 2025-12-29 has its fourth day on Jan 1, 2026, so the
    // whole straddle week lives under YEAR 2026 > January.
    const plan = planEnsureDaily(index(fixture()), {
      dateKey: "2025-12-29",
      ...scaffold(),
      timestamp: T,
    });
    const byId = new Map(inserted(plan.ops).map((n) => [n.id, n]));
    expect(byId.get("yr")!.text).toBe("2026");
    expect(byId.get("mo")!.text).toBe("January");
    expect(byId.get("wk")!.text).toBe("Dec 29, 2025–Jan 4, 2026");
    expect(byId.get("day")!.parentId).toBe("wk");
    expect(byId.get("day")!.text).toBe("Monday, December 29, 2025");
  });

  test("an existing (pre-migration flat) day is reused verbatim, NEVER re-scaffolded", () => {
    // A flat day directly under the container (the old shape). Ensuring it again
    // must not mint a parallel Y/M/W scaffold — the client migrates it later.
    const nodes = [
      ...fixture(),
      createNode({
        id: "cont",
        text: "Daily",
        prevSiblingId: "b",
      }),
      createNode({
        id: "flat",
        text: "Friday, July 3, 2026",
        parentId: "cont",
      }),
    ];
    const rev = new Map<string, string>([
      ["cont", "container"],
      ["flat", "2026-07-03"],
    ]);
    const plan = planEnsureDaily(index(nodes), {
      dateKey: "2026-07-03",
      ...scaffold(rev, { dayId: "flat" }),
      timestamp: T,
    });
    expect(plan.ops).toHaveLength(0); // present + titled -> no-op, no scaffold
  });

  test("heals a blank existing day's text without re-scaffolding", () => {
    const { nodes, rev } = seededWeek("week:2026-06-29", [
      createNode({ id: "day", text: "  ", parentId: "wk" }),
    ]);
    rev.set("day", "2026-07-03");
    const plan = planEnsureDaily(index(nodes), {
      dateKey: "2026-07-03",
      ...scaffold(rev),
      timestamp: T,
    });
    expect(plan.ops).toHaveLength(1);
    expect(updated(plan.ops)[0]!.text).toBe("Friday, July 3, 2026");
  });

  test("self-heals a claimed chain whose node creation was lost", () => {
    // Every kv key is claimed (present in the reverse map) but NONE of the nodes
    // exist in the tree — a crash between the atomic claims and the applyBatch.
    // The next ensure re-materializes the whole chain.
    const rev = new Map<string, string>([
      ["cont", "container"],
      ["yr", "2026"],
      ["mo", "2026-07"],
      ["wk", "week:2026-06-29"],
      ["day", "2026-07-03"],
    ]);
    const plan = planEnsureDaily(index(fixture()), {
      dateKey: "2026-07-03",
      ...scaffold(rev),
      timestamp: T,
    });
    expect(inserted(plan.ops).map((n) => n.id)).toEqual([
      "cont",
      "yr",
      "mo",
      "wk",
      "day",
    ]);
  });

  test("planAddToDaily appends day content under the day, after its last child", () => {
    const { nodes, rev } = seededWeek("week:2026-06-29", [
      createNode({ id: "day", text: "Friday, July 3, 2026", parentId: "wk" }),
      createNode({ id: "entry1", text: "existing", parentId: "day" }),
    ]);
    rev.set("day", "2026-07-03");
    const plan = planAddToDaily(index(nodes), {
      dateKey: "2026-07-03",
      ...scaffold(rev),
      newNodeId: "entry2",
      text: "captured",
      isTask: true,
      timestamp: T,
    });
    const node = inserted(plan.ops)[0]!;
    expect(node.parentId).toBe("day");
    expect(node.prevSiblingId).toBe("entry1");
    expect(node.isTask).toBe(true);

    // Kind rides onto the captured node.
    const prose = planAddToDaily(index([]), {
      dateKey: "2026-07-10",
      ...scaffold(),
      newNodeId: "n",
      text: "prose",
      isTask: false,
      kind: "paragraph",
      timestamp: T,
    });
    expect(inserted(prose.ops).find((n) => n.id === "n")!.kind).toBe(
      "paragraph",
    );
  });

  test("planMirrorToDaily mirrors an outside node and refuses container cycles, existing day or not", () => {
    const { nodes, rev } = seededWeek("week:2026-06-29", [
      createNode({ id: "day", text: "Friday, July 3, 2026", parentId: "wk" }),
    ]);
    rev.set("day", "2026-07-03");
    const mirror = (snapshot: Node[], sourceId: string, map = rev) =>
      planMirrorToDaily(index(snapshot), {
        dateKey: "2026-07-03",
        ...scaffold(map),
        sourceId,
        mirrorId: "mm",
        timestamp: T,
      });

    const plan = mirror(nodes, "a1");
    if (plan instanceof Error) throw plan;
    const node = inserted(plan.ops)[0]!;
    expect(node.mirrorOf).toBe("a1");
    expect(node.parentId).toBe("day");

    expect(mirror(nodes, "cont")).toBeInstanceOf(MirrorCycle);

    // A fresh day/week/month/year aren't in the snapshot, so the cycle guard must
    // fall back to the deepest EXISTING prospective parent (here the container),
    // or it builds a self-cycle (mirror -> container landing under the container).
    const containerOnly = [
      ...fixture(),
      createNode({ id: "cont", text: "Daily", prevSiblingId: "b" }),
    ];
    expect(mirror(containerOnly, "cont", new Map())).toBeInstanceOf(
      MirrorCycle,
    );
  });

  test.each([
    ["2026-07-03", "Friday, July 3, 2026"],
    ["not-a-date", "not-a-date"],
    // Date.UTC rolls these over ("2026-13-45" -> 2027-02-14); the round-trip
    // guard must return the raw key instead of seeding a date months off.
    ["2026-13-45", "2026-13-45"],
    ["2026-02-31", "2026-02-31"],
  ])("formatDayText(%s) is %s", (key, text) => {
    expect(formatDayText(key)).toBe(text);
  });
});

describe("reads", () => {
  /** Flatten the whole outline with generous bounds. */
  const flatAll = (nodes: Node[]) => {
    const result = flattenSubtree(index(nodes), null, {
      maxDepth: 99,
      maxNodes: 100,
    });
    if (result instanceof Error) throw result;
    return result;
  };

  test("formatOutlineLines renders indentation, checkboxes, ids, and kind", () => {
    const result = flatAll([
      createNode({ id: "a", text: "alpha" }),
      createNode({
        id: "a1",
        text: "todo",
        parentId: "a",
        isTask: true,
        completed: true,
      }),
      createNode({
        id: "p",
        text: "alpha prose",
        parentId: "a",
        prevSiblingId: "a1",
        kind: "paragraph",
      }),
      // The illegal pair a raw PATCH or a stale client can still write. The app
      // draws a paragraph glyph and no checkbox; the agent must not be told `- [ ]`.
      createNode({
        id: "q",
        text: "prose",
        prevSiblingId: "a",
        isTask: true,
        kind: "paragraph",
      }),
    ]);
    expect(result.lines.map((l) => l.kind)).toEqual([
      null,
      null,
      "paragraph",
      "paragraph",
    ]);
    expect(result.lines.find((l) => l.id === "q")!.isTask).toBe(false);
    expect(formatOutlineLines(result.lines)).toBe(
      [
        "- alpha (id: a)",
        "  - [x] todo (id: a1)",
        "  - alpha prose (id: p, paragraph)",
        "- prose (id: q, paragraph)",
      ].join("\n"),
    );
  });

  test("flattenSubtree windows a mirror's source children and caps cycles", () => {
    // m mirrors a; a contains m2, which mirrors a again -> the inner instance
    // must render capped instead of recursing forever.
    const nodes = [
      createNode({ id: "a", text: "alpha" }),
      createNode({ id: "a1", text: "kid", parentId: "a" }),
      createNode({
        id: "m2",
        text: "alpha",
        parentId: "a",
        prevSiblingId: "a1",
        mirrorOf: "a",
      }),
      createNode({ id: "m", text: "alpha", prevSiblingId: "a", mirrorOf: "a" }),
    ];
    const result = flattenSubtree(index(nodes), "m", {
      maxDepth: 99,
      maxNodes: 100,
    });
    if (result instanceof Error) throw result;
    const byId = new Map(result.lines.map((l) => [l.id, l]));
    expect(byId.get("m")?.text).toBe("alpha");
    expect(byId.get("a1")?.depth).toBe(1);
    expect(byId.get("m2")?.capped).toBe(true);
    expect(result.lines).toHaveLength(3);
  });

  test("flattenSubtree truncates at maxNodes and reports it", () => {
    const result = flattenSubtree(index(fixture()), null, {
      maxDepth: 99,
      maxNodes: 2,
    });
    if (result instanceof Error) throw result;
    expect(result.lines).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

// The MCP egress redaction (ADR 0043). Client-side stripping is covered by
// src/data/spoiler.test.ts and search redaction by worker/search.test.ts; e2e
// can't reach the Worker serialization (seedOutline mocks it), so these unit
// tests guard the read and export paths: the same carve-out as
// worker/wire.test.ts / worker/mcp.test.ts.
describe("spoiler redaction at the MCP boundary", () => {
  test("flattenSubtree redacts a spoiler run to the [spoiler] sentinel", () => {
    const nodes = [createNode({ id: "a", text: "the killer is ||Bob||" })];
    const result = flattenSubtree(index(nodes), null, {
      maxDepth: 99,
      maxNodes: 100,
    });
    if (result instanceof Error) throw result;
    expect(result.lines[0]!.text).toBe("the killer is [spoiler]");
    expect(result.lines[0]!.text.includes("Bob")).toBe(false);
  });

  test("redactSpoilerIndex rebuilds an index over redacted text (export_opml path)", () => {
    const nodes = [
      createNode({ id: "a", text: "secret is ||42||" }),
      createNode({ id: "a1", text: "plain child", parentId: "a" }),
    ];
    const redacted = redactSpoilerIndex(index(nodes));
    expect(redacted.byId.get("a")!.text).toBe("secret is [spoiler]");
    expect(redacted.byId.get("a1")!.text).toBe("plain child");
    // And the OPML the tool serializes from it carries no spoiler interior.
    const opml = exportOpml(redacted, null, { title: "dotflowy" });
    expect(opml.includes("42")).toBe(false);
    expect(opml.includes("[spoiler]")).toBe(true);
  });
});
