import { describe, expect, test } from "bun:test";

import { buildFilterOperatorMap, buildQueryFilter } from "./filter-query";
import { buildTreeIndex, makeNode } from "./tree";
import {
  buildVisibleRows,
  contentIdForKey,
  findVisibleNeighbor,
  focusKeyAfterEdit,
  instanceIdForKey,
  lastVisibleDescendant,
  parentKeyOf,
  parseRowKey,
  rowKeyFor,
} from "./visible-order";

const show = () => false; // nothing hidden
const hideCompleted = (n: { completed: boolean }) => n.completed;

describe("buildVisibleRows — mirror-free parity (the default path)", () => {
  // A
  //   a1
  //   a2
  // B
  const tree = [
    makeNode({ id: "A", prevSiblingId: null }),
    makeNode({ id: "B", prevSiblingId: "A" }),
    makeNode({ id: "a1", parentId: "A", prevSiblingId: null }),
    makeNode({ id: "a2", parentId: "A", prevSiblingId: "a1" }),
  ];
  const index = buildTreeIndex(tree);

  test("every row is its own content, keyed by bare id, never a mirror", () => {
    const rows = buildVisibleRows(index, null, show);
    expect(rows.map((r) => r.id)).toEqual(["A", "a1", "a2", "B"]);
    for (const r of rows) {
      expect(r.contentId).toBe(r.id);
      expect(r.key).toBe(r.id);
      expect(r.isMirror).toBe(false);
      expect(r.capped).toBe(false);
      expect(r.broken).toBe(false);
    }
  });

  test("depth + fade inheritance unchanged", () => {
    const rows = buildVisibleRows(index, null, show);
    expect(rows.find((r) => r.id === "a1")?.depth).toBe(1);
    expect(rows.find((r) => r.id === "A")?.depth).toBe(0);
  });

  test("a node carrying mirrorOf is treated as normal while the flag is OFF", () => {
    // Same node set, but B mirrors A. With mirrors disabled (default arg) B is an
    // ordinary leaf — no source windowing, no resolution. Byte-identical to today.
    const withMirror = [
      makeNode({ id: "A", prevSiblingId: null }),
      makeNode({ id: "B", prevSiblingId: "A", mirrorOf: "A" }),
      makeNode({ id: "a1", parentId: "A", prevSiblingId: null }),
    ];
    const i2 = buildTreeIndex(withMirror);
    const rows = buildVisibleRows(i2, null, show); // mirrorsEnabled defaults false
    const b = rows.find((r) => r.id === "B")!;
    expect(b.contentId).toBe("B");
    expect(b.isMirror).toBe(false);
    // B's "children" are not A's — A's children don't appear under B.
    expect(rows.map((r) => r.id)).toEqual(["A", "a1", "B"]);
  });
});

describe("buildVisibleRows — mirrors enabled (ADR 0022)", () => {
  // A          (source)
  //   a1
  //   a2
  // P
  //   M -> A   (a mirror of A, windowing a1/a2)
  const tree = [
    makeNode({ id: "A", prevSiblingId: null }),
    makeNode({ id: "P", prevSiblingId: "A" }),
    makeNode({ id: "a1", parentId: "A", prevSiblingId: null }),
    makeNode({ id: "a2", parentId: "A", prevSiblingId: "a1" }),
    makeNode({ id: "M", parentId: "P", prevSiblingId: null, mirrorOf: "A" }),
  ];
  const index = buildTreeIndex(tree);

  test("a mirror windows the source's children", () => {
    const rows = buildVisibleRows(index, null, show, null, true);
    expect(rows.map((r) => r.id)).toEqual([
      "A",
      "a1",
      "a2",
      "P",
      "M",
      "a1",
      "a2",
    ]);

    const m = rows.find((r) => r.id === "M")!;
    expect(m.isMirror).toBe(true);
    expect(m.contentId).toBe("A"); // reads the source's content
    expect(m.key).toBe("M"); // top-level mirror: bare id (no mirror crossed yet)
    expect(m.capped).toBe(false);
    expect(m.broken).toBe(false);
  });

  test("source descendants get unique path keys under the mirror, bare ids under the source", () => {
    const rows = buildVisibleRows(index, null, show, null, true);
    // Two rows share id 'a1' (real + mirrored) but their keys are distinct.
    const a1Rows = rows.filter((r) => r.id === "a1");
    expect(a1Rows).toHaveLength(2);
    const keys = a1Rows.map((r) => r.key);
    expect(keys[0]).toBe("a1"); // under the real source: bare id (today's identity)
    expect(keys[1]).not.toBe("a1"); // under the mirror: a compound path key
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length); // all keys unique
    // The mirrored copies still read their own (real) content.
    for (const r of a1Rows) expect(r.contentId).toBe("a1");
  });

  test("two mirrors of the same source keep distinct keys", () => {
    // P holds two mirrors of A back to back.
    const t2 = [
      makeNode({ id: "A", prevSiblingId: null }),
      makeNode({ id: "P", prevSiblingId: "A" }),
      makeNode({ id: "a1", parentId: "A", prevSiblingId: null }),
      makeNode({ id: "M1", parentId: "P", prevSiblingId: null, mirrorOf: "A" }),
      makeNode({ id: "M2", parentId: "P", prevSiblingId: "M1", mirrorOf: "A" }),
    ];
    const rows = buildVisibleRows(buildTreeIndex(t2), null, show, null, true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  test("collapse is LOCAL to the instance — a collapsed mirror hides the source subtree", () => {
    const t2 = [
      makeNode({ id: "A", prevSiblingId: null }),
      makeNode({ id: "P", prevSiblingId: "A" }),
      makeNode({ id: "a1", parentId: "A", prevSiblingId: null }),
      // The mirror itself is collapsed; the source A is NOT.
      makeNode({
        id: "M",
        parentId: "P",
        prevSiblingId: null,
        mirrorOf: "A",
        collapsed: true,
      }),
    ];
    const rows = buildVisibleRows(buildTreeIndex(t2), null, show, null, true);
    // a1 appears once (under the real, expanded A) — not under the collapsed mirror.
    expect(rows.filter((r) => r.id === "a1")).toHaveLength(1);
    expect(rows.map((r) => r.id)).toEqual(["A", "a1", "P", "M"]);
  });

  test("visibility prunes follow the SOURCE's completed (content), not the instance", () => {
    // Source A is completed; the mirror node M itself is not.
    const t2 = [
      makeNode({ id: "A", prevSiblingId: null, completed: true }),
      makeNode({ id: "P", prevSiblingId: "A" }),
      makeNode({
        id: "M",
        parentId: "P",
        prevSiblingId: null,
        mirrorOf: "A",
        completed: false,
      }),
    ];
    const rows = buildVisibleRows(
      buildTreeIndex(t2),
      null,
      hideCompleted,
      null,
      true,
    );
    // Hide-completed reads the resolved content (A is completed), so the mirror is
    // pruned — checking the source off hides every instance.
    expect(rows.some((r) => r.id === "M")).toBe(false);
    expect(rows.some((r) => r.id === "A")).toBe(false);
  });
});

describe("buildVisibleRows — cycle + broken guards", () => {
  test("a mirror whose source is an ancestor caps instead of looping", () => {
    // A contains a mirror of A — an immediate cycle.
    const t = [
      makeNode({ id: "A", prevSiblingId: null }),
      makeNode({ id: "M", parentId: "A", prevSiblingId: null, mirrorOf: "A" }),
    ];
    const rows = buildVisibleRows(buildTreeIndex(t), null, show, null, true);
    const m = rows.find((r) => r.id === "M")!;
    expect(m.isMirror).toBe(true);
    expect(m.capped).toBe(true);
    // Capped => not expanded: no second copy of M (or A) underneath it.
    expect(rows.map((r) => r.id)).toEqual(["A", "M"]);
  });

  test("a deep cycle (mirror of an ancestor several levels up) still caps", () => {
    // A > b > M(->A): M's source A is an expanded ancestor.
    const t = [
      makeNode({ id: "A", prevSiblingId: null }),
      makeNode({ id: "b", parentId: "A", prevSiblingId: null }),
      makeNode({ id: "M", parentId: "b", prevSiblingId: null, mirrorOf: "A" }),
    ];
    const rows = buildVisibleRows(buildTreeIndex(t), null, show, null, true);
    expect(rows.find((r) => r.id === "M")?.capped).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(["A", "b", "M"]);
  });

  test("a mirror whose source is missing renders a broken leaf, never throws", () => {
    const t = [makeNode({ id: "M", prevSiblingId: null, mirrorOf: "ghost" })];
    const rows = buildVisibleRows(buildTreeIndex(t), null, show, null, true);
    const m = rows.find((r) => r.id === "M")!;
    expect(m.broken).toBe(true);
    expect(m.contentId).toBe("ghost");
    expect(rows).toHaveLength(1); // no children expanded
  });
});

describe("row-key helpers (the Stage 2 identity keystone, ADR 0022)", () => {
  // A          (source)
  //   a1
  // P
  //   M -> A   (windows a1)
  const tree = [
    makeNode({ id: "A", prevSiblingId: null }),
    makeNode({ id: "P", prevSiblingId: "A" }),
    makeNode({ id: "a1", parentId: "A", prevSiblingId: null }),
    makeNode({ id: "M", parentId: "P", prevSiblingId: null, mirrorOf: "A" }),
  ];
  const index = buildTreeIndex(tree);

  test("parseRowKey / instanceIdForKey: a bare id is a single segment", () => {
    expect(parseRowKey("a1")).toEqual(["a1"]);
    expect(instanceIdForKey("a1")).toBe("a1");
  });

  test("rowKeyFor composes, and parseRowKey is its inverse", () => {
    const childKey = rowKeyFor("M", "a1");
    expect(parseRowKey(childKey)).toEqual(["M", "a1"]);
    expect(instanceIdForKey(childKey)).toBe("a1");
    // Top level (no prefix) is the bare id — today's identity.
    expect(rowKeyFor(null, "x")).toBe("x");
    // Nesting composes left-to-right.
    expect(parseRowKey(rowKeyFor(rowKeyFor("M", "a1"), "leaf"))).toEqual([
      "M",
      "a1",
      "leaf",
    ]);
  });

  test("rowKeyFor matches the address buildVisibleRows actually emits", () => {
    const rows = buildVisibleRows(index, null, show, null, true);
    // a1 appears under the real source (bare id) and under the mirror (path key).
    const windowed = rows.find((r) => r.id === "a1" && r.key !== "a1")!;
    expect(windowed.key).toBe(rowKeyFor("M", "a1"));
  });

  test("contentIdForKey resolves a mirror to its source, a real node to itself", () => {
    // The mirror row's key resolves to the SOURCE's content id.
    expect(contentIdForKey(index, "M")).toBe("A");
    // A windowed real descendant reads its own content (it is not itself a mirror).
    expect(contentIdForKey(index, rowKeyFor("M", "a1"))).toBe("a1");
    // A bare real node is its own content.
    expect(contentIdForKey(index, "a1")).toBe("a1");
    // Unknown node falls back to the raw instance id, never throws.
    expect(contentIdForKey(index, "ghost")).toBe("ghost");
  });

  test("INVARIANT: helpers agree with every row buildVisibleRows emits", () => {
    const rows = buildVisibleRows(index, null, show, null, true);
    for (const r of rows) {
      // The key always points back at the row's own instance id...
      expect(instanceIdForKey(r.key)).toBe(r.id);
      // ...and resolves to the same content id the walk computed.
      expect(contentIdForKey(index, r.key)).toBe(r.contentId);
    }
  });

  test("INVARIANT: key === id for a mirror-free tree (flag-off parity budget)", () => {
    const plain = buildTreeIndex([
      makeNode({ id: "A", prevSiblingId: null }),
      makeNode({ id: "a1", parentId: "A", prevSiblingId: null }),
      makeNode({ id: "a2", parentId: "A", prevSiblingId: "a1" }),
    ]);
    const rows = buildVisibleRows(plain, null, show, null, true);
    for (const r of rows) {
      expect(r.key).toBe(r.id);
      expect(instanceIdForKey(r.key)).toBe(r.id);
      expect(contentIdForKey(plain, r.key)).toBe(r.id);
    }
  });
});

describe("parentKeyOf (Stage 2c focus composition)", () => {
  test("a bare key has no parent (top level / pre-mirror)", () => {
    expect(parentKeyOf("a1")).toBeNull();
  });

  test("drops the last segment of a compound key", () => {
    expect(parentKeyOf(rowKeyFor("M", "a1"))).toBe("M");
    expect(parentKeyOf(rowKeyFor(rowKeyFor("M", "a1"), "leaf"))).toBe(
      rowKeyFor("M", "a1"),
    );
  });

  test("inverse of rowKeyFor: recompose a sibling under the same parent", () => {
    const child = rowKeyFor("M", "a1");
    // A sibling of `child` shares its parent prefix.
    expect(rowKeyFor(parentKeyOf(child), "a2")).toBe(rowKeyFor("M", "a2"));
    // For a bare key the sibling stays bare (today's identity).
    expect(rowKeyFor(parentKeyOf("a1"), "a2")).toBe("a2");
  });
});

describe("focusKeyAfterEdit (land focus in the editing instance, ADR 0022 2c)", () => {
  // A          (source)
  //   a1
  //   a2
  // P
  //   M -> A   (windows a1, a2)
  const tree = [
    makeNode({ id: "A", prevSiblingId: null }),
    makeNode({ id: "P", prevSiblingId: "A" }),
    makeNode({ id: "a1", parentId: "A", prevSiblingId: null }),
    makeNode({ id: "a2", parentId: "A", prevSiblingId: "a1" }),
    makeNode({ id: "M", parentId: "P", prevSiblingId: null, mirrorOf: "A" }),
  ];
  const rows = buildVisibleRows(buildTreeIndex(tree), null, show, null, true);

  test("a unique (mirror-free) id resolves to its own bare key", () => {
    // P appears once; the active key is irrelevant.
    expect(focusKeyAfterEdit(rows, "P", "anything")).toBe("P");
  });

  test("a duplicated id resolves to the copy under the active mirror anchor", () => {
    // a1 appears under the real source (key 'a1') AND under the mirror M
    // (key M·a1). Editing under M must keep focus under M, not teleport to A.
    expect(focusKeyAfterEdit(rows, "a1", rowKeyFor("M", "a2"))).toBe(
      rowKeyFor("M", "a1"),
    );
    // Conversely, editing under the real source (bare active key) keeps the bare
    // copy.
    expect(focusKeyAfterEdit(rows, "a1", "a2")).toBe("a1");
  });

  test("a newly inserted source child lands under the editing mirror", () => {
    // Simulate inserting a child `n` under source A: it windows under M too.
    const withChild = buildVisibleRows(
      buildTreeIndex([
        ...tree,
        makeNode({ id: "n", parentId: "A", prevSiblingId: "a2" }),
      ]),
      null,
      show,
      null,
      true,
    );
    // Editing on the mirror row M (active key 'M'): focus the windowed copy.
    expect(focusKeyAfterEdit(withChild, "n", "M")).toBe(rowKeyFor("M", "n"));
    // Editing on the real source A (active key 'A'): focus the bare copy.
    expect(focusKeyAfterEdit(withChild, "n", "A")).toBe("n");
  });

  test("returns null when the id is no longer visible (moved out of the view)", () => {
    expect(focusKeyAfterEdit(rows, "ghost", "M")).toBeNull();
  });
});

describe("caret nav under an active ?q= filter (render parity, ADR 0047)", () => {
  // A #go
  // P            (no tag -- dimmed ancestor context of K)
  //   K #go
  // B            (no tag, no tagged descendant -- filtered OUT of the render)
  // C #go
  // P2 (collapsed, no tag -- context ancestor; filter force-descends to D)
  //   D #go
  const tree = [
    makeNode({ id: "A", prevSiblingId: null, text: "alpha #go" }),
    makeNode({ id: "P", prevSiblingId: "A", text: "parent" }),
    makeNode({ id: "K", parentId: "P", prevSiblingId: null, text: "kid #go" }),
    makeNode({ id: "B", prevSiblingId: "P", text: "bravo" }),
    makeNode({ id: "C", prevSiblingId: "B", text: "charlie #go" }),
    makeNode({ id: "P2", prevSiblingId: "C", text: "papa", collapsed: true }),
    makeNode({
      id: "D",
      parentId: "P2",
      prevSiblingId: null,
      text: "deep #go",
    }),
  ];
  const index = buildTreeIndex(tree);
  const filter = buildQueryFilter(
    index,
    null,
    "#go",
    show,
    buildFilterOperatorMap([]),
  )!;

  test("fixture sanity: the filter renders A, P, K, C, P2, D and drops B", () => {
    const rows = buildVisibleRows(index, null, show, filter);
    expect(rows.map((r) => r.id)).toEqual(["A", "P", "K", "C", "P2", "D"]);
  });

  test("Down skips a filtered-out row instead of handing back an unmounted one", () => {
    // Unfiltered, K's down-neighbor is B; B isn't rendered under the filter, so
    // returning it pins focus (the filtered-nav bug). Render parity says C.
    expect(findVisibleNeighbor(index, null, "K", "down", show, filter)).toBe(
      "C",
    );
    expect(findVisibleNeighbor(index, null, "C", "up", show, filter)).toBe("K");
  });

  test("nav lands on dimmed ancestor context rows (they're rendered + editable)", () => {
    expect(findVisibleNeighbor(index, null, "A", "down", show, filter)).toBe(
      "P",
    );
  });

  test("a row revealed under a collapsed context ancestor is reachable", () => {
    // D renders (filter force-descends P2) but isn't in the unfiltered walk at
    // all -- indexOf would be -1 and every arrow from D a no-op.
    expect(findVisibleNeighbor(index, null, "P2", "down", show, filter)).toBe(
      "D",
    );
    expect(findVisibleNeighbor(index, null, "D", "up", show, filter)).toBe(
      "P2",
    );
    expect(
      findVisibleNeighbor(index, null, "D", "down", show, filter),
    ).toBeNull();
  });

  test("lastVisibleDescendant descends a collapsed context ancestor to its revealed match", () => {
    expect(lastVisibleDescendant(index, "P2", show, filter)).toBe("D");
    // ...but stops at children the filter prunes: B has none visible anyway,
    // and P's only child K is visible, so parity holds there too.
    expect(lastVisibleDescendant(index, "P", show, filter)).toBe("K");
  });

  test("lastVisibleDescendant stops at a COLLAPSED MATCH (its children aren't revealed)", () => {
    // M #go is collapsed with an untagged child: pass 2 skips collapsed
    // matches, so the child isn't in visibleIds and the walk must end at M.
    const t2 = [
      makeNode({
        id: "M",
        prevSiblingId: null,
        text: "m #go",
        collapsed: true,
      }),
      makeNode({ id: "m1", parentId: "M", prevSiblingId: null, text: "inner" }),
    ];
    const i2 = buildTreeIndex(t2);
    const f2 = buildQueryFilter(
      i2,
      null,
      "#go",
      show,
      buildFilterOperatorMap([]),
    )!;
    expect(lastVisibleDescendant(i2, "M", show, f2)).toBe("M");
  });

  test("no filter (null) keeps today's unfiltered behavior byte-for-byte", () => {
    expect(findVisibleNeighbor(index, null, "K", "down", show)).toBe("B");
    expect(lastVisibleDescendant(index, "P2", show)).toBe("P2");
  });
});
