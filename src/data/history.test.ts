import { beforeEach, describe, expect, test } from "bun:test";

import type { Node } from "./tree";

import {
  capture,
  clearHistory,
  finishHistoryScope,
  getHistoryState,
  redo,
  undo,
} from "./history";
import { buildTreeIndex, createNode } from "./tree";
import { rowKeyFor } from "./visible-order";

const EMPTY = buildTreeIndex([]);

function createNodes(count: number, prefix = "n"): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < count; i++)
    nodes.push(createNode({ id: `${prefix}${i}` }));
  return nodes;
}

beforeEach(() => {
  clearHistory();
});

test("a draft scope cannot undo older edits and collapses to one capture on close", () => {
  const base = buildTreeIndex([createNode({ id: "a", text: "before" })]);
  const edited = buildTreeIndex([createNode({ id: "a", text: "after" })]);
  const born = buildTreeIndex([
    ...edited.byId.values(),
    createNode({ id: "draft", text: "first" }),
  ]);
  const typed = buildTreeIndex([
    ...edited.byId.values(),
    createNode({ id: "draft", text: "finished" }),
  ]);
  capture(base, "a");
  expect(undo(edited, null, "draft-1")).toBeNull();
  capture(edited, null, null, { scope: "draft-1", label: "capture" });
  capture(born, "draft", null, { scope: "draft-1", label: "typing" });
  finishHistoryScope("draft-1");
  expect(getHistoryState().undoLabel).toBe("Undo capture");
  expect(undo(typed)?.opCount).toBe(1);
  expect(undo(edited)?.opCount).toBe(1);
});

test("finishing a draft does not fold across an independent move", () => {
  const a = createNode({ id: "a" });
  const draft = createNode({ id: "draft", text: "first" });
  const moved = createNode({ ...a, parentId: "draft" });
  capture(buildTreeIndex([a]), null, null, {
    scope: "draft-1",
    label: "capture",
  });
  capture(buildTreeIndex([a, draft]), "a", null, { label: "move" });
  capture(buildTreeIndex([moved, draft]), "draft", null, {
    scope: "draft-1",
    label: "typing",
  });
  finishHistoryScope("draft-1");
  const live = buildTreeIndex([moved, { ...draft, text: "finished" }]);
  expect(undo(live)?.changedIds).toEqual(["draft"]);
  expect(undo(buildTreeIndex([moved, draft]))?.changedIds).toEqual(["a"]);
});

test("history exposes action labels and clearing removes both directions", () => {
  const idx = buildTreeIndex([createNode({ id: "a" })]);
  capture(idx, "a", null, { label: "move" });
  expect(getHistoryState().undoLabel).toBe("Undo move");
  undo(idx);
  expect(getHistoryState().redoLabel).toBe("Redo move");
  clearHistory();
  expect(getHistoryState().canUndo).toBe(false);
  expect(getHistoryState().canRedo).toBe(false);
});

test("undo and redo move one entry between the stacks; capture and drop manage redo", () => {
  const idx = buildTreeIndex([createNode({ id: "a" })]);
  const idxB = buildTreeIndex([createNode({ id: "b" })]);

  // An empty stack undoes and redoes to null.
  expect(undo(idx)).toBeNull();
  expect(redo(idx)).toBeNull();

  // undo moves the entry to the redo stack; redo moves it back.
  capture(idx, "a");
  expect(undo(idx)).not.toBeNull();
  expect(undo(idx)).toBeNull();
  expect(redo(idx)).not.toBeNull();
  expect(redo(idx)).toBeNull();
  expect(undo(idx)).not.toBeNull(); // the redo stack now holds it again

  // A no-op mutation captures (clearing redo), then drops: redo comes back.
  const dropNoop = capture(idxB, "b");
  dropNoop();
  expect(redo(idxB)).not.toBeNull();

  // A real new action forks the timeline: redo is gone for good.
  undo(idx);
  capture(idx, "a");
  expect(redo(idx)).toBeNull();

  // drop with no redo to restore just pops the undo point.
  clearHistory();
  const drop = capture(idx, "a");
  drop();
  expect(undo(idx)).toBeNull();
});

// An empty index only ever reaches capture() when the caller read a starved
// node source -- `nodesCollection` is ready-and-empty while the Lunora flag is
// ON (ADR 0058). Storing that snapshot makes the next Cmd+Z classify every live
// node as a delete, so capture refuses it and the matching drop no-ops.
test("a refused empty capture pushes nothing and leaves both stacks intact", () => {
  const idxA = buildTreeIndex([createNode({ id: "a" })]);

  capture(EMPTY, "a");
  expect(undo(idxA)).toBeNull();

  capture(idxA, "a");
  undo(idxA); // the redo stack now holds one entry
  capture(EMPTY, "ghost"); // refused: never forked the timeline
  expect(redo(idxA)).not.toBeNull();
});

test("drop after a refused capture keeps the newest real entry", () => {
  // Each index holds the node its focus names, so the restored focusId
  // survives planRestore's "is it still in the snapshot" gate and identifies
  // WHICH entry came back.
  const idxOlder = buildTreeIndex([createNode({ id: "older" })]);
  const idxNewer = buildTreeIndex([createNode({ id: "newer" })]);

  capture(idxOlder, "older");
  capture(idxNewer, "newer");
  const drop = capture(EMPTY, "ghost");
  drop(); // the command's no-op arm: must NOT eat the "newer" entry

  expect(undo(idxNewer)!.focusId).toBe("newer");
  expect(undo(idxOlder)!.focusId).toBe("older");
});

test("a refused capture does not disarm the NEXT drop", () => {
  const idxA = buildTreeIndex([createNode({ id: "a" })]);
  capture(EMPTY, "ghost"); // refused, owns no undo point
  const drop = capture(idxA, "a"); // a real push owns its rollback
  drop(); // must pop the real entry

  expect(undo(idxA)).toBeNull();
});

test("a coalesced no-op keeps the typing run and a late drop cannot replace newer history", async () => {
  const idx = buildTreeIndex([createNode({ id: "a", text: "before" })]);
  const edited = buildTreeIndex([createNode({ id: "a", text: "after" })]);
  capture(idx, "a", "text:a");
  capture(edited, "a", "text:a")();
  expect(undo(edited)?.opCount).toBe(1);

  // A pending action owns the old redo only until it completes. Another
  // action may finish first; the older failure must not pop that newer entry.
  const dropPending = capture(idx, "a", null, { label: "import" });
  await Promise.resolve();
  capture(edited, "a", null, { label: "move" });
  dropPending();
  expect(getHistoryState().undoLabel).toBe("Undo move");
  expect(getHistoryState().canRedo).toBe(false);
  expect(undo(idx)?.opCount).toBe(1);
  expect(undo(idx)?.label).toBe("import");

  const dropCleared = capture(idx, "a");
  clearHistory();
  capture(edited, "a", null, { label: "create" });
  dropCleared();
  expect(getHistoryState().undoLabel).toBe("Undo create");
  expect(getHistoryState().canRedo).toBe(false);
});

describe("MAX_ENTRIES eviction", () => {
  test("caps the undo stack at 100, evicting the oldest entries", () => {
    const idx = buildTreeIndex(createNodes(105, "f"));

    for (let i = 0; i < 105; i++) capture(idx, `f${i}`);

    // Drain the whole stack, newest first, recording each entry's focus.
    const focuses: (string | null)[] = [];
    let plan = undo(idx);
    while (plan) {
      focuses.push(plan.focusId);
      plan = undo(idx);
    }

    expect(focuses).toHaveLength(100);
    expect(focuses[0]).toBe("f104"); // newest survives
    expect(focuses[99]).toBe("f5"); // oldest surviving; f0..f4 were evicted
    expect(focuses).not.toContain("f0");
    expect(focuses).not.toContain("f4");
  });
});

test("a no-op at the cap restores the evicted undo point", () => {
  const idx = buildTreeIndex(createNodes(101, "f"));
  for (let i = 0; i < 100; i++) capture(idx, `f${i}`);
  const drop = capture(idx, "f100");
  drop();
  drop(); // consuming the handle twice cannot eat another action
  const focuses: (string | null)[] = [];
  let plan = undo(idx);
  while (plan) {
    focuses.push(plan.focusId);
    plan = undo(idx);
  }
  expect(focuses).toHaveLength(100);
  expect(focuses[0]).toBe("f99");
  expect(focuses[99]).toBe("f0");
});

const tagIdx = buildTreeIndex([createNode({ id: "a" })]);
function undoDepth(): number {
  let n = 0;
  while (undo(tagIdx)) n++;
  return n;
}

test.each<[string, Array<string | null>, number]>([
  ["consecutive same tag coalesces", ["text:a", "text:a"], 1],
  ["different tags do not coalesce", ["text:a", "text:b"], 2],
  ["a null tag never coalesces", [null, null], 2],
  ["coalescing only checks the TOP entry", ["text:a", "text:b", "text:a"], 3],
])("capture tag-coalescing: %s", (_name, tags, depth) => {
  for (const tag of tags) capture(tagIdx, "a", tag);
  expect(undoDepth()).toBe(depth);
});

test("typing after undo clears redo even when the previous tag matches", () => {
  capture(tagIdx, "a", "text:a");
  capture(tagIdx, "a", "text:b");
  undo(tagIdx); // pops 'text:b'; redo holds one entry; top is 'text:a'
  capture(tagIdx, "a", "text:a");
  expect(redo(tagIdx)).toBeNull();
});

describe("revert() reverses the stack mutation", () => {
  const idxA = buildTreeIndex([createNode({ id: "a" })]);
  const idxB = buildTreeIndex([createNode({ id: "b" })]);

  test("undo() then revert() returns to the pre-undo state", () => {
    capture(idxA, "a");

    const plan = undo(idxB, "b");
    expect(plan).not.toBeNull();

    plan!.revert();

    // The redo push is undone...
    expect(redo(idxB)).toBeNull();
    // ...and the ORIGINAL entry is back on the undo stack (its own focus "a",
    // proving it is the same entry, not the pre-undo redo snapshot).
    const restored = undo(idxB, "b");
    expect(restored).not.toBeNull();
    expect(restored!.focusId).toBe("a");
  });

  test("redo() then revert() returns to the pre-redo state", () => {
    capture(idxA, "a");
    undo(idxB, "b"); // redo stack now holds the pre-undo snapshot (focus "b")

    const plan = redo(idxB, "c");
    expect(plan).not.toBeNull();

    plan!.revert();

    // The undo push is undone...
    expect(undo(idxB)).toBeNull();
    // ...and the redo entry is back, still carrying its captured focus "b".
    const restored = redo(idxB);
    expect(restored).not.toBeNull();
    expect(restored!.focusId).toBe("b");
  });
});

const a = createNode({ id: "a" });
const b = createNode({ id: "b" });
const x = createNode({ id: "x" });
const y = createNode({ id: "y" });
test.each<[string, Node[], Node[], number, number]>([
  ["identical snapshots", [a, b], [a, b], 0, 0],
  ["a node added since the snapshot is a delete", [a], [a, b], 1, 1],
  ["a node removed since the snapshot is an upsert", [a, b], [a], 1, 1],
  // delete x + upsert y = 2 ops, chunked per group -> 2 slices
  ["deletes and upserts chunk into separate slices", [a, y], [a, x], 2, 2],
])("planRestore: %s", (_name, snap, live, opCount, slices) => {
  capture(buildTreeIndex(snap), "a");
  const plan = undo(buildTreeIndex(live))!;
  expect(plan.opCount).toBe(opCount);
  expect(plan.slices).toHaveLength(slices);
});

test("planRestore slices upserts and deletes at 500 ops", () => {
  // All snapshot nodes are re-inserts against an EMPTY live tree.
  capture(buildTreeIndex(createNodes(500)), null);
  expect(undo(EMPTY)!.slices).toHaveLength(1);
  clearHistory();
  capture(buildTreeIndex(createNodes(501)), null);
  const over = undo(EMPTY)!;
  expect(over.opCount).toBe(501);
  expect(over.slices).toHaveLength(2);

  // The snapshot keeps ONE node and the live tree adds the rest, so every
  // extra node is a delete. (`capture` refuses an EMPTY snapshot.)
  for (const [deletes, slices] of [
    [500, 1],
    [501, 2],
  ] as const) {
    clearHistory();
    const all = createNodes(deletes + 1);
    capture(buildTreeIndex([all[0]!]), null);
    const plan = undo(buildTreeIndex(all))!;
    expect(plan.opCount).toBe(deletes);
    expect(plan.slices).toHaveLength(slices);
  }
});

test.each<[string, string[], string | null, string | null]>([
  ["survives when its node is in the snapshot", ["a"], "a", "a"],
  ["is dropped when its node is gone", ["a"], "ghost", null],
  ["stays null when null", ["a"], null, null],
  // A row key inside a mirrored subtree; the gate reads only the last segment.
  [
    "a composite key is kept whole",
    ["a"],
    rowKeyFor("p", "a"),
    rowKeyFor("p", "a"),
  ],
  [
    "a composite key is dropped on its last segment",
    ["z"],
    rowKeyFor("p", "a"),
    null,
  ],
])("planRestore focusId %s", (_name, ids, focus, expected) => {
  const idx = buildTreeIndex(ids.map((id) => createNode({ id })));
  capture(idx, focus);
  expect(undo(idx)!.focusId).toBe(expected);
});

// Every persisted field participates in the diff -- but browsing state and
// timestamps alone never create restore writes.
const base = { id: "n", createdAt: 1, updatedAt: 1 } as const;
test.each<[string, Partial<Node>, number]>([
  ["text", { text: "changed" }, 1],
  ["parentId", { parentId: "p" }, 1],
  ["prevSiblingId", { prevSiblingId: "s" }, 1],
  ["isTask", { isTask: true }, 1],
  ["completed", { completed: true }, 1],
  ["mirrorOf", { mirrorOf: "m" }, 1],
  ["kind", { kind: "paragraph" }, 1],
  [
    "collapsed, bookmarkedAt, updatedAt",
    { collapsed: true, bookmarkedAt: 123, updatedAt: 9 },
    0,
  ],
])("planRestore: a change to %s registers %d op(s)", (_name, override, ops) => {
  capture(buildTreeIndex([createNode(base)]), "n");
  const live = buildTreeIndex([createNode({ ...base, ...override })]);
  expect(undo(live)!.opCount).toBe(ops);
});
