import { beforeEach, describe, expect, test } from "bun:test";

import type { Node } from "./tree";

import { capture, drop, redo, RESTORE_SLICE_OPS, undo } from "./history";
import { buildTreeIndex, makeNode } from "./tree";
import { rowKeyFor } from "./visible-order";

// history.ts keeps the undo/redo stacks as module singletons with no exported
// reset. undo/redo only SHUFFLE entries between the two stacks (the sum is
// conserved), so neither can drain both. `capture` clears the redo stack, so
// two captures leave it empty with an empty backup, and `drop` then pops the
// undo entries back off -- draining all three pieces of state to a clean slate.
const EMPTY = buildTreeIndex([]);
function resetHistory(): void {
  while (undo(EMPTY)) {
    /* move every undo entry onto the redo stack */
  }
  capture(EMPTY);
  capture(EMPTY);
  drop();
  drop();
}

function makeNodes(count: number, prefix = "n"): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < count; i++) nodes.push(makeNode({ id: `${prefix}${i}` }));
  return nodes;
}

beforeEach(resetHistory);

describe("capture / undo / redo / drop stack transfer", () => {
  const idx = buildTreeIndex([makeNode({ id: "a" })]);

  test("an empty stack undoes and redoes to null", () => {
    expect(undo(idx)).toBeNull();
    expect(redo(idx)).toBeNull();
  });

  test("capture then undo yields a plan, then the stack is empty", () => {
    capture(idx, "a");
    expect(undo(idx)).not.toBeNull();
    expect(undo(idx)).toBeNull();
  });

  test("undo moves the entry to the redo stack; redo moves it back", () => {
    capture(idx, "a");

    expect(undo(idx)).not.toBeNull();
    // undo stack is now empty...
    expect(undo(idx)).toBeNull();
    // ...and the entry sits on the redo stack.
    expect(redo(idx)).not.toBeNull();
    expect(redo(idx)).toBeNull();
    // redo pushed it back onto the undo stack.
    expect(undo(idx)).not.toBeNull();
  });

  test("a fresh capture clears the redo stack", () => {
    capture(idx, "a");
    undo(idx); // -> redo stack now holds one entry
    capture(idx, "a"); // a new action forks the timeline
    expect(redo(idx)).toBeNull();
  });

  test("drop restores the redo stack a no-op capture cleared", () => {
    const idxA = buildTreeIndex([makeNode({ id: "a" })]);
    const idxB = buildTreeIndex([makeNode({ id: "b" })]);

    capture(idxA, "a");
    undo(idxA); // populate the redo stack
    capture(idxB, "b"); // clears redo, stashing it in the backup
    drop(); // the mutation was a no-op: put the redo stack back

    expect(redo(idxB)).not.toBeNull();
  });

  test("drop with nothing to restore just pops the undo point", () => {
    capture(idx, "a");
    drop();
    expect(undo(idx)).toBeNull();
  });
});

describe("MAX_ENTRIES eviction", () => {
  test("caps the undo stack at 100, evicting the oldest entries", () => {
    const idx = buildTreeIndex(makeNodes(105, "f"));

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

describe("capture tag-coalescing", () => {
  const idx = buildTreeIndex([makeNode({ id: "a" })]);

  function undoDepth(): number {
    let n = 0;
    while (undo(idx)) n++;
    return n;
  }

  test("consecutive same non-null tag coalesces into one entry", () => {
    capture(idx, "a", "text:a");
    capture(idx, "a", "text:a");
    expect(undoDepth()).toBe(1);
  });

  test("different tags do not coalesce", () => {
    capture(idx, "a", "text:a");
    capture(idx, "a", "text:b");
    expect(undoDepth()).toBe(2);
  });

  test("a null tag never coalesces, even consecutively", () => {
    capture(idx, "a", null);
    capture(idx, "a", null);
    expect(undoDepth()).toBe(2);
  });

  test("coalescing only checks the TOP entry", () => {
    capture(idx, "a", "text:a");
    capture(idx, "a", "text:b");
    // 'text:a' matches an entry underneath, but not the top -> still pushes.
    capture(idx, "a", "text:a");
    expect(undoDepth()).toBe(3);
  });

  test("a coalesced capture does not clear the redo stack", () => {
    // Set the undo stack up so its TOP shares the tag we re-capture, while a
    // redo entry is live underneath.
    capture(idx, "a", "text:a");
    capture(idx, "a", "text:b");
    undo(idx); // pops 'text:b'; redo stack now holds one entry; top is 'text:a'
    capture(idx, "a", "text:a"); // coalesced -> early return, redo untouched
    expect(redo(idx)).not.toBeNull();
  });
});

describe("revert() reverses the stack mutation", () => {
  const idxA = buildTreeIndex([makeNode({ id: "a" })]);
  const idxB = buildTreeIndex([makeNode({ id: "b" })]);

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

describe("planRestore opCount / slices.length / focusId", () => {
  test("identical snapshots produce zero ops and zero slices", () => {
    const idx = buildTreeIndex([makeNode({ id: "a" }), makeNode({ id: "b" })]);
    capture(idx, "a");
    const plan = undo(idx)!;
    expect(plan.opCount).toBe(0);
    expect(plan.slices).toHaveLength(0);
  });

  test("a node added since the snapshot is a delete", () => {
    const a = makeNode({ id: "a" });
    const b = makeNode({ id: "b" });
    const snap = buildTreeIndex([a]); // captured state
    const live = buildTreeIndex([a, b]); // b was added since

    capture(snap, "a");
    const plan = undo(live)!;
    expect(plan.opCount).toBe(1); // delete b
    expect(plan.slices).toHaveLength(1);
  });

  test("a node removed since the snapshot is an upsert", () => {
    const a = makeNode({ id: "a" });
    const b = makeNode({ id: "b" });
    const snap = buildTreeIndex([a, b]); // captured state
    const live = buildTreeIndex([a]); // b was removed since

    capture(snap, "a");
    const plan = undo(live)!;
    expect(plan.opCount).toBe(1); // re-insert b
    expect(plan.slices).toHaveLength(1);
  });

  test("a changed field is an upsert", () => {
    const before = makeNode({
      id: "a",
      text: "before",
      createdAt: 1,
      updatedAt: 1,
    });
    const after = makeNode({
      id: "a",
      text: "after",
      createdAt: 1,
      updatedAt: 1,
    });
    const snap = buildTreeIndex([before]);
    const live = buildTreeIndex([after]);

    capture(snap, "a");
    const plan = undo(live)!;
    expect(plan.opCount).toBe(1);
  });

  test("deletes and upserts chunk into separate slices", () => {
    const a = makeNode({ id: "a" });
    const x = makeNode({ id: "x" });
    const y = makeNode({ id: "y" });
    const snap = buildTreeIndex([a, y]); // captured: a, y
    const live = buildTreeIndex([a, x]); // now: a, x

    capture(snap, "a");
    const plan = undo(live)!;
    // delete x + upsert y = 2 ops, but chunked per group -> 2 slices.
    expect(plan.opCount).toBe(2);
    expect(plan.slices).toHaveLength(2);
  });

  test("upserts at exactly RESTORE_SLICE_OPS are one slice; one more is two", () => {
    const make = (count: number) => buildTreeIndex(makeNodes(count));

    capture(make(RESTORE_SLICE_OPS), null);
    const exact = undo(EMPTY)!; // all 500 are re-inserts
    expect(exact.opCount).toBe(RESTORE_SLICE_OPS);
    expect(exact.slices).toHaveLength(1);

    resetHistory();
    capture(make(RESTORE_SLICE_OPS + 1), null);
    const over = undo(EMPTY)!;
    expect(over.opCount).toBe(RESTORE_SLICE_OPS + 1);
    expect(over.slices).toHaveLength(2);
  });

  test("deletes at exactly RESTORE_SLICE_OPS are one slice; one more is two", () => {
    const make = (count: number) => buildTreeIndex(makeNodes(count));

    capture(EMPTY, null); // captured empty; every live node is a delete
    const exact = undo(make(RESTORE_SLICE_OPS))!;
    expect(exact.opCount).toBe(RESTORE_SLICE_OPS);
    expect(exact.slices).toHaveLength(1);

    resetHistory();
    capture(EMPTY, null);
    const over = undo(make(RESTORE_SLICE_OPS + 1))!;
    expect(over.opCount).toBe(RESTORE_SLICE_OPS + 1);
    expect(over.slices).toHaveLength(2);
  });

  test("focusId survives when its node is in the restored snapshot", () => {
    const idx = buildTreeIndex([makeNode({ id: "a" })]);
    capture(idx, "a");
    expect(undo(idx)!.focusId).toBe("a");
  });

  test("focusId is dropped when its node is gone from the snapshot", () => {
    const idx = buildTreeIndex([makeNode({ id: "a" })]);
    capture(idx, "ghost"); // focus points at a node not in the snapshot
    expect(undo(idx)!.focusId).toBeNull();
  });

  test("a null focus stays null", () => {
    const idx = buildTreeIndex([makeNode({ id: "a" })]);
    capture(idx, null);
    expect(undo(idx)!.focusId).toBeNull();
  });

  test("a composite row key is gated on its last segment but returned whole", () => {
    // A row key inside a mirrored subtree joins its instance-id chain with the
    // real PATH_SEP (rowKeyFor, visible-order.ts); the focus gate reads only
    // the last segment.
    const key = rowKeyFor("p", "a");

    const present = buildTreeIndex([makeNode({ id: "a" })]);
    capture(present, key);
    expect(undo(present)!.focusId).toBe(key); // last segment "a" exists -> full key

    resetHistory();
    const absent = buildTreeIndex([makeNode({ id: "z" })]);
    capture(absent, key);
    expect(undo(absent)!.focusId).toBeNull(); // last segment "a" absent -> dropped
  });
});

describe("sameNode field comparison boundaries", () => {
  // Every persisted field participates in the diff (nodes are flat records, so
  // sameNode is a full shallow compare) -- including createdAt/updatedAt.
  const fieldChanges: Array<{ field: string; override: Partial<Node> }> = [
    { field: "text", override: { text: "changed" } },
    { field: "parentId", override: { parentId: "p" } },
    { field: "prevSiblingId", override: { prevSiblingId: "s" } },
    { field: "isTask", override: { isTask: true } },
    { field: "completed", override: { completed: true } },
    { field: "collapsed", override: { collapsed: true } },
    { field: "bookmarkedAt", override: { bookmarkedAt: 123 } },
    { field: "mirrorOf", override: { mirrorOf: "m" } },
    { field: "kind", override: { kind: "paragraph" } },
    { field: "origin", override: { origin: "agent" } },
    { field: "createdAt", override: { createdAt: 2 } },
    { field: "updatedAt", override: { updatedAt: 2 } },
  ];

  const base = { id: "n", createdAt: 1, updatedAt: 1 } as const;

  for (const { field, override } of fieldChanges) {
    test(`a change to ${field} registers as one op`, () => {
      const snap = buildTreeIndex([makeNode(base)]);
      const live = buildTreeIndex([makeNode({ ...base, ...override })]);
      capture(snap, "n");
      expect(undo(live)!.opCount).toBe(1);
    });
  }

  test("no field change registers zero ops (control)", () => {
    const snap = buildTreeIndex([makeNode(base)]);
    const live = buildTreeIndex([makeNode(base)]);
    capture(snap, "n");
    expect(undo(live)!.opCount).toBe(0);
  });
});
