/**
 * The server-side outline planners (worker/outline-ops.ts): pure snapshot ->
 * ChangeOp-batch logic, the Worker twin of the client's mutations. Unit-tested
 * here because the chain surgery (insert repoints, cascade delete relinks,
 * mirror flatten/cycle rules, daily materialization) is exactly the kind of
 * pure logic bun test owns — e2e can't reach it (the MCP endpoint has no
 * browser caller). Fixtures use `makeNode()` (tree.ts), the canonical builder.
 */

import { describe, expect, test } from "bun:test";

import type { ChangeOp, Node } from "../src/data/wire-schema";

import { weekLabel } from "../src/data/date-links";
import { exportOpml } from "../src/data/opml-export";
import { makeNode } from "../src/data/tree";
import {
  BatchTooLarge,
  DAILY_CONTAINER_TEXT,
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
  searchNodes,
} from "./outline-ops";

const T = 1_700_000_000_000;

/** a -> b (top level), with a1 -> a2 under a. */
function fixture(): Node[] {
  return [
    makeNode({ id: "a", text: "alpha" }),
    makeNode({ id: "b", text: "bravo", prevSiblingId: "a" }),
    makeNode({ id: "a1", text: "alpha one", parentId: "a" }),
    makeNode({
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
  test("appends as the last child without repointing anyone", () => {
    const plan = planAddNode(index(fixture()), {
      id: "new",
      text: "x",
      parentId: "a",
      position: "last",
      isTask: false,
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    expect(plan.ops).toHaveLength(1);
    const node = inserted(plan.ops)[0]!;
    expect(node.parentId).toBe("a");
    expect(node.prevSiblingId).toBe("a2");
  });

  test("inserting first repoints the old head", () => {
    const plan = planAddNode(index(fixture()), {
      id: "new",
      text: "x",
      parentId: "a",
      position: "first",
      isTask: true,
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const node = inserted(plan.ops)[0]!;
    expect(node.prevSiblingId).toBeNull();
    expect(node.isTask).toBe(true);
    const repointed = updated(plan.ops)[0]!;
    expect(repointed.id).toBe("a1");
    expect(repointed.prevSiblingId).toBe("new");
  });

  test("null parent adds at the top level after the last root", () => {
    const plan = planAddNode(index(fixture()), {
      id: "new",
      text: "x",
      parentId: null,
      position: "last",
      isTask: false,
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const node = inserted(plan.ops)[0]!;
    expect(node.parentId).toBeNull();
    expect(node.prevSiblingId).toBe("b");
  });

  test("a mirror parent redirects to its true source", () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: "m", text: "alpha", mirrorOf: "a", prevSiblingId: "b" }),
    ];
    const plan = planAddNode(index(nodes), {
      id: "new",
      text: "x",
      parentId: "m",
      position: "last",
      isTask: false,
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    expect(inserted(plan.ops)[0]!.parentId).toBe("a");
  });

  test("missing parent is NodeNotFound", () => {
    const plan = planAddNode(index(fixture()), {
      id: "new",
      text: "x",
      parentId: "ghost",
      position: "last",
      isTask: false,
      timestamp: T,
    });
    expect(plan).toBeInstanceOf(NodeNotFound);
  });

  test("stamps the provenance origin onto the created node (default null)", () => {
    // The MCP write path passes the caller's harness name; the created node
    // carries it verbatim (write-once). Every content planner threads it the
    // same way — planAddNode stands in for all of them here.
    const agent = planAddNode(index(fixture()), {
      id: "ai",
      text: "x",
      parentId: "a",
      position: "last",
      isTask: false,
      origin: "Claude",
      timestamp: T,
    });
    if (agent instanceof Error) throw agent;
    expect(inserted(agent.ops)[0]!.origin).toBe("Claude");

    // Omitting origin (a non-MCP caller) defaults to null — human-authored.
    const human = planAddNode(index(fixture()), {
      id: "me",
      text: "x",
      parentId: "a",
      position: "last",
      isTask: false,
      timestamp: T,
    });
    if (human instanceof Error) throw human;
    expect(inserted(human.ops)[0]!.origin).toBeNull();
  });
});

describe("planUpdateNode", () => {
  test("merges field changes into one update op", () => {
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
  });

  test("content fields on a mirror land on the source; collapsed stays local", () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: "m", text: "alpha", mirrorOf: "a", prevSiblingId: "b" }),
    ];
    const plan = planUpdateNode(index(nodes), {
      nodeId: "m",
      changes: { text: "shared edit", collapsed: true },
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const byId = new Map(updated(plan.ops).map((n) => [n.id, n]));
    expect(byId.get("a")?.text).toBe("shared edit");
    expect(byId.get("m")?.collapsed).toBe(true);
    // The mirror's own text is untouched (display snapshot; reads resolve live).
    expect(byId.get("m")?.text).toBe("alpha");
  });

  test("missing node is NodeNotFound", () => {
    const plan = planUpdateNode(index(fixture()), {
      nodeId: "ghost",
      changes: { text: "x" },
      timestamp: T,
    });
    expect(plan).toBeInstanceOf(NodeNotFound);
  });

  // Kind exclusivity at the trust boundary (ADR 0045): the server normalizes the
  // pair exactly as the client funnels do, so no agent can persist an illegal one.
  test("setting kind=paragraph clears isTask", () => {
    const nodes = [makeNode({ id: "t", text: "job", isTask: true })];
    const plan = planUpdateNode(index(nodes), {
      nodeId: "t",
      changes: { kind: "paragraph" },
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const node = updated(plan.ops)[0]!;
    expect(node.kind).toBe("paragraph");
    expect(node.isTask).toBe(false);
  });

  test("setting isTask clears kind", () => {
    const nodes = [makeNode({ id: "p", text: "prose", kind: "paragraph" })];
    const plan = planUpdateNode(index(nodes), {
      nodeId: "p",
      changes: { isTask: true },
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const node = updated(plan.ops)[0]!;
    expect(node.isTask).toBe(true);
    expect(node.kind).toBeNull();
  });

  test("kind wins when an agent passes both in one call", () => {
    const nodes = [makeNode({ id: "n", text: "x" })];
    const plan = planUpdateNode(index(nodes), {
      nodeId: "n",
      changes: { isTask: true, kind: "paragraph" },
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const node = updated(plan.ops)[0]!;
    expect(node.kind).toBe("paragraph");
    expect(node.isTask).toBe(false);
  });

  test("kind=null turns a paragraph back into a plain bullet", () => {
    const nodes = [makeNode({ id: "p", text: "prose", kind: "paragraph" })];
    const plan = planUpdateNode(index(nodes), {
      nodeId: "p",
      changes: { kind: null },
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    expect(updated(plan.ops)[0]!.kind).toBeNull();
  });
});

describe("kind at the write planners", () => {
  /** A deterministic id factory: n0, n1, n2, ... in emission order. */
  const idFactory = () => {
    let i = 0;
    return () => `n${i++}`;
  };

  test("planAddNode creates a paragraph, and a paragraph is never a task", () => {
    const plan = planAddNode(index(fixture()), {
      id: "new",
      text: "prose",
      parentId: null,
      position: "last",
      isTask: true,
      kind: "paragraph",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const node = inserted(plan.ops)[0]!;
    expect(node.kind).toBe("paragraph");
    expect(node.isTask).toBe(false);
  });

  test("planAddNode defaults to a bullet", () => {
    const plan = planAddNode(index(fixture()), {
      id: "new",
      text: "x",
      parentId: null,
      position: "last",
      isTask: false,
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    expect(inserted(plan.ops)[0]!.kind).toBeNull();
  });

  test("planAddSubtree carries kind per node, root and descendant", () => {
    const plan = planAddSubtree(index(fixture()), {
      nodes: [
        {
          text: "heading",
          children: [
            { text: "prose", kind: "paragraph" },
            { text: "task", isTask: true },
          ],
        },
      ],
      parentId: null,
      position: "last",
      timestamp: T,
      newId: idFactory(),
      maxNodes: 10,
    });
    if (plan instanceof Error) throw plan;
    const byText = new Map(inserted(plan.ops).map((n) => [n.text, n]));
    expect(byText.get("heading")!.kind).toBeNull();
    expect(byText.get("prose")!.kind).toBe("paragraph");
    expect(byText.get("task")!.kind).toBeNull();
    expect(byText.get("task")!.isTask).toBe(true);
  });

  test("planAddToDaily carries kind onto the captured node", () => {
    const plan = planAddToDaily(index([]), {
      dateKey: "2026-07-10",
      ...scaffold(),
      newNodeId: "n",
      text: "prose",
      isTask: false,
      kind: "paragraph",
      timestamp: T,
    });
    const node = inserted(plan.ops).find((n) => n.id === "n")!;
    expect(node.kind).toBe("paragraph");
  });
});

describe("planDeleteNode", () => {
  test("cascades the subtree and repoints the follower sibling", () => {
    const plan = planDeleteNode(index(fixture()), "a", T);
    if (plan instanceof Error) throw plan;
    expect(new Set(deletedKeys(plan.ops))).toEqual(new Set(["a", "a1", "a2"]));
    const repointed = updated(plan.ops)[0]!;
    expect(repointed.id).toBe("b");
    expect(repointed.prevSiblingId).toBeNull();
  });

  test("refuses when the subtree has surviving mirrors elsewhere", () => {
    const nodes = [
      ...fixture(),
      makeNode({
        id: "m",
        text: "alpha one",
        mirrorOf: "a1",
        prevSiblingId: "b",
      }),
    ];
    const plan = planDeleteNode(index(nodes), "a", T);
    expect(plan).toBeInstanceOf(WouldOrphanMirrors);
  });

  test("deleting a mirror itself is safe and touches only the mirror", () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: "m", text: "alpha", mirrorOf: "a", prevSiblingId: "b" }),
    ];
    const plan = planDeleteNode(index(nodes), "m", T);
    if (plan instanceof Error) throw plan;
    expect(deletedKeys(plan.ops)).toEqual(["m"]);
  });
});

describe("planMirrorNode", () => {
  test("mirrors as the last child, flattening mirror-of-mirror to the true source", () => {
    const nodes = [
      ...fixture(),
      makeNode({
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
  });

  test("refuses to mirror a node into its own subtree", () => {
    const plan = planMirrorNode(index(fixture()), {
      sourceId: "a",
      targetParentId: "a1",
      id: "mm",
      timestamp: T,
    });
    expect(plan).toBeInstanceOf(MirrorCycle);
  });
});

describe("planReparent", () => {
  const move = (nodes: Node[], args: Parameters<typeof planReparent>[1]) =>
    planReparent(index(nodes), args);

  /** The emitted update ops, keyed by node id. */
  const movedById = (ops: ChangeOp[]) =>
    new Map(updated(ops).map((n) => [n.id, n]));

  test("moves a single node to the last child of a parent", () => {
    const plan = move(fixture(), {
      nodeIds: ["b"],
      newParentId: "a",
      position: "last",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const b = movedById(plan.ops).get("b")!;
    expect(b.parentId).toBe("a");
    expect(b.prevSiblingId).toBe("a2");
    expect(b.updatedAt).toBe(T);
    expect(plan.parentId).toBe("a");
    expect(plan.movedIds).toEqual(["b"]);
  });

  test('position "first" pushes the old head down', () => {
    const plan = move(fixture(), {
      nodeIds: ["b"],
      newParentId: "a",
      position: "first",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const byId = movedById(plan.ops);
    expect(byId.get("b")!.prevSiblingId).toBeNull();
    expect(byId.get("b")!.parentId).toBe("a");
    // the former first child now follows the moved node
    expect(byId.get("a1")!.prevSiblingId).toBe("b");
  });

  test("a batch keeps the passed order (last)", () => {
    const nodes = [
      makeNode({ id: "p", text: "parent" }),
      makeNode({ id: "x", text: "x", prevSiblingId: "p" }),
      makeNode({ id: "y", text: "y", prevSiblingId: "x" }),
    ];
    const plan = move(nodes, {
      nodeIds: ["x", "y"],
      newParentId: "p",
      position: "last",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const byId = movedById(plan.ops);
    expect(byId.get("x")!.parentId).toBe("p");
    expect(byId.get("x")!.prevSiblingId).toBeNull();
    expect(byId.get("y")!.parentId).toBe("p");
    expect(byId.get("y")!.prevSiblingId).toBe("x");
  });

  test("a batch keeps the passed order at the front (first)", () => {
    const nodes = [
      makeNode({ id: "p", text: "parent" }),
      makeNode({ id: "z", text: "z", parentId: "p" }),
      makeNode({ id: "x", text: "x", prevSiblingId: "p" }),
      makeNode({ id: "y", text: "y", prevSiblingId: "x" }),
    ];
    const plan = move(nodes, {
      nodeIds: ["x", "y"],
      newParentId: "p",
      position: "first",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const byId = movedById(plan.ops);
    expect(byId.get("x")!.prevSiblingId).toBeNull();
    expect(byId.get("y")!.prevSiblingId).toBe("x");
    // the pre-existing child is pushed below the moved run
    expect(byId.get("z")!.prevSiblingId).toBe("y");
  });

  test("a run of mutual siblings keeps its chain (no tearing)", () => {
    // Both a1 and a2 are children of a; moving both under b must not self-ref or
    // reorder — the bug the rebuild-between-moves guard exists to prevent.
    const plan = move(fixture(), {
      nodeIds: ["a1", "a2"],
      newParentId: "b",
      position: "last",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const byId = movedById(plan.ops);
    expect(byId.get("a1")!.parentId).toBe("b");
    expect(byId.get("a1")!.prevSiblingId).toBeNull();
    expect(byId.get("a2")!.parentId).toBe("b");
    expect(byId.get("a2")!.prevSiblingId).toBe("a1");
  });

  test("moves across different parents in one call", () => {
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
  });

  test("null parent moves to the top level after the last root", () => {
    const plan = move(fixture(), {
      nodeIds: ["a1"],
      newParentId: null,
      position: "last",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const byId = movedById(plan.ops);
    expect(byId.get("a1")!.parentId).toBeNull();
    expect(byId.get("a1")!.prevSiblingId).toBe("b");
    // the follower under the old parent inherits the moved node's old predecessor
    expect(byId.get("a2")!.prevSiblingId).toBeNull();
  });

  test("a mirror parent redirects to its true source", () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: "m", text: "alpha", mirrorOf: "a", prevSiblingId: "b" }),
    ];
    const plan = move(nodes, {
      nodeIds: ["b"],
      newParentId: "m",
      position: "last",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    expect(plan.parentId).toBe("a");
    expect(movedById(plan.ops).get("b")!.parentId).toBe("a");
  });

  test("emits ONLY update ops — never recreates a node (ADR 0027)", () => {
    const plan = move(fixture(), {
      nodeIds: ["a1", "b"],
      newParentId: "a2",
      position: "last",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    expect(inserted(plan.ops)).toHaveLength(0);
    expect(deletedKeys(plan.ops)).toHaveLength(0);
    expect(plan.ops.every((op) => op.op === "update")).toBe(true);
  });

  test("deduplicates repeated ids, preserving first-seen order", () => {
    const plan = move(fixture(), {
      nodeIds: ["b", "b"],
      newParentId: "a",
      position: "last",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    expect(plan.movedIds).toEqual(["b"]);
    expect(movedById(plan.ops).get("b")!.parentId).toBe("a");
  });

  test("a missing node is NodeNotFound", () => {
    expect(
      move(fixture(), {
        nodeIds: ["ghost"],
        newParentId: "a",
        position: "last",
        timestamp: T,
      }),
    ).toBeInstanceOf(NodeNotFound);
  });

  test("a missing parent is NodeNotFound", () => {
    expect(
      move(fixture(), {
        nodeIds: ["a1"],
        newParentId: "ghost",
        position: "last",
        timestamp: T,
      }),
    ).toBeInstanceOf(NodeNotFound);
  });

  test("moving a node under itself is WouldCycle", () => {
    expect(
      move(fixture(), {
        nodeIds: ["a"],
        newParentId: "a",
        position: "last",
        timestamp: T,
      }),
    ).toBeInstanceOf(WouldCycle);
  });

  test("moving a node under its own descendant is WouldCycle", () => {
    expect(
      move(fixture(), {
        nodeIds: ["a"],
        newParentId: "a1",
        position: "last",
        timestamp: T,
      }),
    ).toBeInstanceOf(WouldCycle);
  });

  test("listing a node alongside its own moved ancestor is RedundantDescendant", () => {
    expect(
      move(fixture(), {
        nodeIds: ["a", "a1"],
        newParentId: "b",
        position: "last",
        timestamp: T,
      }),
    ).toBeInstanceOf(RedundantDescendant);
  });
});

describe("planAddSubtree", () => {
  /** A deterministic id factory: n0, n1, n2, ... in emission order. */
  const idFactory = () => {
    let i = 0;
    return () => `n${i++}`;
  };

  test("wires a run of sibling roots into one unbroken chain (the trap)", () => {
    // Three top-level roots under `a`: looping planAddNode over a stale index
    // would give each the same prevSiblingId (a2) and tear the chain. By
    // construction each root chains to the previous one.
    const plan = planAddSubtree(index(fixture()), {
      nodes: [{ text: "one" }, { text: "two" }, { text: "three" }],
      parentId: "a",
      position: "last",
      timestamp: T,
      newId: idFactory(),
      maxNodes: 500,
    });
    if (plan instanceof Error) throw plan;
    const nodes = inserted(plan.ops);
    expect(nodes.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);
    expect(nodes.map((n) => n.parentId)).toEqual(["a", "a", "a"]);
    // First root chains after the parent's existing last child (a2), the rest
    // chain to their predecessor — no shared predecessor, no self-ref.
    expect(nodes.map((n) => n.prevSiblingId)).toEqual(["a2", "n0", "n1"]);
    expect(plan.rootIds).toEqual(["n0", "n1", "n2"]);
    expect(plan.parentId).toBe("a");
  });

  test("nests children depth-first, each level its own chain", () => {
    const plan = planAddSubtree(index([]), {
      nodes: [
        {
          text: "root",
          children: [
            { text: "c1", children: [{ text: "g1" }, { text: "g2" }] },
            { text: "c2" },
          ],
        },
      ],
      parentId: null,
      position: "last",
      timestamp: T,
      newId: idFactory(),
      maxNodes: 500,
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
  });

  test('position "first" puts the run at the head and repoints the old head to the run tail', () => {
    const plan = planAddSubtree(index(fixture()), {
      nodes: [{ text: "one" }, { text: "two" }],
      parentId: "a",
      position: "first",
      timestamp: T,
      newId: idFactory(),
      maxNodes: 500,
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
    const nodes = [
      ...fixture(),
      makeNode({ id: "m", text: "alpha", mirrorOf: "a", prevSiblingId: "b" }),
    ];
    const plan = planAddSubtree(index(nodes), {
      nodes: [{ text: "x" }],
      parentId: "m",
      position: "last",
      timestamp: T,
      newId: idFactory(),
      maxNodes: 500,
    });
    if (plan instanceof Error) throw plan;
    expect(inserted(plan.ops)[0]!.parentId).toBe("a");
    expect(plan.parentId).toBe("a");
  });

  test("stamps origin onto every authored node, root and descendant", () => {
    const plan = planAddSubtree(index([]), {
      nodes: [{ text: "root", children: [{ text: "kid" }] }],
      parentId: null,
      position: "last",
      origin: "Claude",
      timestamp: T,
      newId: idFactory(),
      maxNodes: 500,
    });
    if (plan instanceof Error) throw plan;
    expect(inserted(plan.ops).every((n) => n.origin === "Claude")).toBe(true);
  });

  test("empty forest is EmptyForest", () => {
    expect(
      planAddSubtree(index(fixture()), {
        nodes: [],
        parentId: "a",
        position: "last",
        timestamp: T,
        newId: idFactory(),
        maxNodes: 500,
      }),
    ).toBeInstanceOf(EmptyForest);
  });

  test("a forest over the cap is BatchTooLarge (descendants counted)", () => {
    // 1 root + 2 children = 3 nodes; cap of 2 must reject.
    const plan = planAddSubtree(index([]), {
      nodes: [{ text: "root", children: [{ text: "a" }, { text: "b" }] }],
      parentId: null,
      position: "last",
      timestamp: T,
      newId: idFactory(),
      maxNodes: 2,
    });
    expect(plan).toBeInstanceOf(BatchTooLarge);
  });

  test("a missing parent is NodeNotFound", () => {
    expect(
      planAddSubtree(index(fixture()), {
        nodes: [{ text: "x" }],
        parentId: "ghost",
        position: "last",
        timestamp: T,
        newId: idFactory(),
        maxNodes: 500,
      }),
    ).toBeInstanceOf(NodeNotFound);
  });

  test("planAddSubtreeToDaily materializes the day and appends the forest after its last child", () => {
    const nodes = [
      ...fixture(),
      makeNode({ id: "cont", text: DAILY_CONTAINER_TEXT, prevSiblingId: "b" }),
      makeNode({ id: "day", text: "Friday, July 3, 2026", parentId: "cont" }),
      makeNode({ id: "existing", text: "already here", parentId: "day" }),
    ];
    const plan = planAddSubtreeToDaily(index(nodes), {
      nodes: [{ text: "one" }, { text: "two" }],
      dateKey: "2026-07-03",
      ...scaffold(),
      timestamp: T,
      newId: idFactory(),
      maxNodes: 500,
    });
    if (plan instanceof Error) throw plan;
    const inserts = inserted(plan.ops);
    expect(inserts.map((n) => n.parentId)).toEqual(["day", "day"]);
    expect(inserts[0]!.prevSiblingId).toBe("existing");
    expect(inserts[1]!.prevSiblingId).toBe(inserts[0]!.id);
    expect(plan.rootIds).toHaveLength(2);
  });

  test("planAddSubtreeToDaily creates the container + day when absent, then appends", () => {
    const plan = planAddSubtreeToDaily(index(fixture()), {
      nodes: [{ text: "one" }],
      dateKey: "2026-07-03",
      ...scaffold(),
      timestamp: T,
      newId: idFactory(),
      maxNodes: 500,
    });
    if (plan instanceof Error) throw plan;
    const ids = inserted(plan.ops).map((n) => n.id);
    // container + year + month + week + day (materialized) + the forest node
    expect(ids).toContain("cont");
    expect(ids).toContain("yr");
    expect(ids).toContain("mo");
    expect(ids).toContain("wk");
    expect(ids).toContain("day");
    const entry = inserted(plan.ops).find(
      (n) => n.parentId === "day" && n.id.startsWith("n"),
    )!;
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
      makeNode({ id: "cont", text: DAILY_CONTAINER_TEXT, prevSiblingId: "b" }),
      makeNode({ id: "yr", text: "2026", parentId: "cont" }),
      makeNode({ id: "mo", text: "July", parentId: "yr" }),
      makeNode({ id: "wk", text: weekLabel(weekKey), parentId: "mo" }),
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
    expect(byId.get("cont")!.text).toBe(DAILY_CONTAINER_TEXT);
    expect(byId.get("yr")!.parentId).toBe("cont");
    expect(byId.get("yr")!.text).toBe("2026");
    expect(byId.get("mo")!.parentId).toBe("yr");
    expect(byId.get("mo")!.text).toBe("July");
    expect(byId.get("wk")!.parentId).toBe("mo");
    expect(byId.get("wk")!.text).toBe("Week 27");
    expect(byId.get("day")!.parentId).toBe("wk");
    expect(byId.get("day")!.prevSiblingId).toBeNull();
    expect(byId.get("day")!.text).toBe("Friday, July 3, 2026");
  });

  test("a second day in the same week reuses year/month/week, only minting the day", () => {
    // 2026-07-13 and 2026-07-16 are both ISO Week 29.
    const { nodes, rev } = seededWeek("2026-W29", [
      makeNode({ id: "d13", text: "Monday, July 13, 2026", parentId: "wk" }),
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

  test("an out-of-order EARLIER day inserts BEFORE its later sibling (ascending)", () => {
    // Week 29 already holds 07-16; ensuring 07-13 must land before it — retiring
    // the old "past day lands on top" caveat (decision 4).
    const { nodes, rev } = seededWeek("2026-W29", [
      makeNode({ id: "d16", text: "Thursday, July 16, 2026", parentId: "wk" }),
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
      makeNode({ id: "cont", text: DAILY_CONTAINER_TEXT }),
      makeNode({ id: "yr25", text: "2025", parentId: "cont" }),
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

  test("the Thursday rule places a late-December day in the NEXT ISO year", () => {
    // 2025-12-29 (a Monday) is ISO 2026-W01: its Thursday is Jan 1, 2026, so the
    // whole straddle week lives under YEAR 2026 > January > Week 1.
    const plan = planEnsureDaily(index(fixture()), {
      dateKey: "2025-12-29",
      ...scaffold(),
      timestamp: T,
    });
    const byId = new Map(inserted(plan.ops).map((n) => [n.id, n]));
    expect(byId.get("yr")!.text).toBe("2026");
    expect(byId.get("mo")!.text).toBe("January");
    expect(byId.get("wk")!.text).toBe("Week 1");
    expect(byId.get("day")!.parentId).toBe("wk");
    expect(byId.get("day")!.text).toBe("Monday, December 29, 2025");
  });

  test("an existing (pre-migration flat) day is reused verbatim, NEVER re-scaffolded", () => {
    // A flat day directly under the container (the old shape). Ensuring it again
    // must not mint a parallel Y/M/W scaffold — the client migrates it later.
    const nodes = [
      ...fixture(),
      makeNode({ id: "cont", text: DAILY_CONTAINER_TEXT, prevSiblingId: "b" }),
      makeNode({ id: "flat", text: "Friday, July 3, 2026", parentId: "cont" }),
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
    const { nodes, rev } = seededWeek("2026-W27", [
      makeNode({ id: "day", text: "  ", parentId: "wk" }),
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
      ["wk", "2026-W27"],
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
    const { nodes, rev } = seededWeek("2026-W27", [
      makeNode({ id: "day", text: "Friday, July 3, 2026", parentId: "wk" }),
      makeNode({ id: "entry1", text: "existing", parentId: "day" }),
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
  });

  test("planMirrorToDaily refuses mirroring the container onto its own day", () => {
    const { nodes, rev } = seededWeek("2026-W27", [
      makeNode({ id: "day", text: "Friday, July 3, 2026", parentId: "wk" }),
    ]);
    rev.set("day", "2026-07-03");
    const plan = planMirrorToDaily(index(nodes), {
      dateKey: "2026-07-03",
      ...scaffold(rev),
      sourceId: "cont",
      mirrorId: "mm",
      timestamp: T,
    });
    expect(plan).toBeInstanceOf(MirrorCycle);
  });

  test("planMirrorToDaily refuses mirroring an ancestor onto a not-yet-created day", () => {
    // A fresh day/week/month/year aren't in the snapshot, so the cycle guard must
    // fall back to the deepest EXISTING prospective parent (here the container),
    // or it builds a self-cycle (mirror -> container landing under the container).
    const nodes = [
      ...fixture(),
      makeNode({ id: "cont", text: DAILY_CONTAINER_TEXT, prevSiblingId: "b" }),
    ];
    const plan = planMirrorToDaily(index(nodes), {
      dateKey: "2026-07-03",
      ...scaffold(), // yr/mo/wk/day all absent from the snapshot
      sourceId: "cont",
      mirrorId: "mm",
      timestamp: T,
    });
    expect(plan).toBeInstanceOf(MirrorCycle);
  });

  test("planMirrorToDaily mirrors an outside node onto the day", () => {
    const { nodes, rev } = seededWeek("2026-W27", [
      makeNode({ id: "day", text: "Friday, July 3, 2026", parentId: "wk" }),
    ]);
    rev.set("day", "2026-07-03");
    const plan = planMirrorToDaily(index(nodes), {
      dateKey: "2026-07-03",
      ...scaffold(rev),
      sourceId: "a1",
      mirrorId: "mm",
      timestamp: T,
    });
    if (plan instanceof Error) throw plan;
    const node = inserted(plan.ops)[0]!;
    expect(node.mirrorOf).toBe("a1");
    expect(node.parentId).toBe("day");
  });

  test("formatDayText renders the seeded full date", () => {
    expect(formatDayText("2026-07-03")).toBe("Friday, July 3, 2026");
    expect(formatDayText("not-a-date")).toBe("not-a-date");
  });

  test("formatDayText returns the raw key for a shaped-but-impossible date", () => {
    // Date.UTC rolls these over ("2026-13-45" -> 2027-02-14); the round-trip
    // guard must reject them instead of seeding a date months off the key.
    expect(formatDayText("2026-13-45")).toBe("2026-13-45");
    expect(formatDayText("2026-02-31")).toBe("2026-02-31");
  });
});

describe("reads", () => {
  test("kind reaches the agent through flattenSubtree, formatOutlineLines, and search", () => {
    const nodes = [
      makeNode({ id: "a", text: "alpha" }),
      makeNode({
        id: "p",
        text: "alpha prose",
        parentId: "a",
        kind: "paragraph",
      }),
    ];
    const result = flattenSubtree(index(nodes), null, {
      maxDepth: 99,
      maxNodes: 100,
    });
    if (result instanceof Error) throw result;
    expect(result.lines.map((l) => l.kind)).toEqual([null, "paragraph"]);
    expect(formatOutlineLines(result.lines)).toBe(
      ["- alpha (id: a)", "  - alpha prose (id: p, paragraph)"].join("\n"),
    );
    expect(searchNodes(index(nodes), "prose", 10)[0]!.kind).toBe("paragraph");
  });

  test("kind outranks isTask on the agent read path, as it does in the renderer", () => {
    // The illegal pair a raw PATCH or a stale client can still write. The app
    // draws a pilcrow and no checkbox; the agent must not be told `- [ ]`.
    const nodes = [
      makeNode({ id: "p", text: "prose", isTask: true, kind: "paragraph" }),
    ];
    const result = flattenSubtree(index(nodes), null, {
      maxDepth: 99,
      maxNodes: 100,
    });
    if (result instanceof Error) throw result;
    expect(result.lines[0]!.isTask).toBe(false);
    expect(formatOutlineLines(result.lines)).toBe("- prose (id: p, paragraph)");
  });

  test("flattenSubtree windows a mirror's source children and caps cycles", () => {
    // m mirrors a; a contains m2, which mirrors a again -> the inner instance
    // must render capped instead of recursing forever.
    const nodes = [
      makeNode({ id: "a", text: "alpha" }),
      makeNode({ id: "a1", text: "kid", parentId: "a" }),
      makeNode({
        id: "m2",
        text: "alpha",
        parentId: "a",
        prevSiblingId: "a1",
        mirrorOf: "a",
      }),
      makeNode({ id: "m", text: "alpha", prevSiblingId: "a", mirrorOf: "a" }),
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

  test("formatOutlineLines renders indentation, checkboxes, and ids", () => {
    const nodes = [
      makeNode({ id: "a", text: "alpha" }),
      makeNode({
        id: "a1",
        text: "todo",
        parentId: "a",
        isTask: true,
        completed: true,
      }),
    ];
    const result = flattenSubtree(index(nodes), null, {
      maxDepth: 99,
      maxNodes: 100,
    });
    if (result instanceof Error) throw result;
    expect(formatOutlineLines(result.lines)).toBe(
      "- alpha (id: a)\n  - [x] todo (id: a1)",
    );
  });

  test("searchNodes matches case-insensitively with a breadcrumb path", () => {
    const hits = searchNodes(index(fixture()), "ALPHA ONE", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe("a1");
    expect(hits[0]!.path).toEqual(["alpha"]);
  });

  test("searchNodes caps at the limit", () => {
    expect(searchNodes(index(fixture()), "alpha", 2)).toHaveLength(2);
  });
});

// The MCP egress redaction (ADR 0043). Client-side stripping is covered by
// src/data/spoiler.test.ts; e2e can't reach the Worker serialization (seedOutline
// mocks it), so these unit tests are the redaction's only guard — the same
// carve-out as worker/wire.test.ts / worker/mcp.test.ts.
describe("spoiler redaction at the MCP boundary", () => {
  test("flattenSubtree redacts a spoiler run to the [spoiler] sentinel", () => {
    const nodes = [makeNode({ id: "a", text: "the killer is ||Bob||" })];
    const result = flattenSubtree(index(nodes), null, {
      maxDepth: 99,
      maxNodes: 100,
    });
    if (result instanceof Error) throw result;
    expect(result.lines[0]!.text).toBe("the killer is [spoiler]");
    expect(result.lines[0]!.text.includes("Bob")).toBe(false);
  });

  test("searchNodes cannot match a term that lives only inside a spoiler", () => {
    const nodes = [makeNode({ id: "a", text: "the killer is ||Bob||" })];
    // "Bob" exists in the source but only inside the spoiler -> zero hits, not a
    // masked hit (an agent must not be able to confirm the term is in there).
    expect(searchNodes(index(nodes), "Bob", 10)).toHaveLength(0);
    // A term OUTSIDE the spoiler still matches, and the returned text is redacted.
    const hits = searchNodes(index(nodes), "killer", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe("the killer is [spoiler]");
  });

  test("searchNodes redacts spoilers in the ancestor breadcrumb path", () => {
    // An ancestor bullet can hold a spoiler; its crumb must be redacted too.
    const nodes = [
      makeNode({ id: "p", text: "chapter ||twist||" }),
      makeNode({ id: "c", text: "a clue", parentId: "p" }),
    ];
    const hits = searchNodes(index(nodes), "clue", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toEqual(["chapter [spoiler]"]);
  });

  test("redactSpoilerIndex rebuilds an index over redacted text (export_opml path)", () => {
    const nodes = [
      makeNode({ id: "a", text: "secret is ||42||" }),
      makeNode({ id: "a1", text: "plain child", parentId: "a" }),
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
