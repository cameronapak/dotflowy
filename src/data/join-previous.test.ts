import { describe, expect, test } from "bun:test";

import { buildFilterOperatorMap, buildQueryFilter } from "./filter-query";
import { planJoinPrevious } from "./join-previous";
import { buildTreeIndex, makeNode } from "./tree";

const show = () => false; // nothing hidden
const hideCompleted = (n: { completed: boolean }) => n.completed;

describe("planJoinPrevious — the happy path", () => {
  // A "alpha"
  //   a1 "one"
  //   a2 "two"
  // B "bravo"
  const tree = [
    makeNode({ id: "A", prevSiblingId: null, text: "alpha" }),
    makeNode({ id: "a1", parentId: "A", prevSiblingId: null, text: "one" }),
    makeNode({ id: "a2", parentId: "A", prevSiblingId: "a1", text: "two" }),
    makeNode({ id: "B", prevSiblingId: "A", text: "bravo" }),
  ];
  const index = buildTreeIndex(tree);

  test("a plain previous sibling is the target, seam at its length", () => {
    const plan = planJoinPrevious(index, "a2", null, show, null, false);
    expect(plan).toEqual({
      kind: "join",
      targetKey: "a1",
      targetId: "a1",
      targetContentId: "a1",
      seamOffset: 3, // "one".length
      sourceText: "two",
    });
  });

  test("the first child merges into its PARENT (a different depth)", () => {
    const plan = planJoinPrevious(index, "a1", null, show, null, false);
    expect(plan).toMatchObject({
      kind: "join",
      targetKey: "A",
      seamOffset: 5, // "alpha".length
      sourceText: "one",
    });
  });

  test("a top-level row merges into the previous sibling's DEEPEST last descendant", () => {
    // B's previous visible row is a2, not A -- the accepted sharp edge of the
    // "previous visible row" rule (matches the post-delete focus walk).
    const plan = planJoinPrevious(index, "B", null, show, null, false);
    expect(plan).toMatchObject({
      kind: "join",
      targetKey: "a2",
      seamOffset: 3,
      sourceText: "bravo",
    });
  });

  test("a COLLAPSED previous sibling is itself the target (collapse never disqualifies)", () => {
    // A is collapsed, so a1/a2 aren't visible rows in EITHER walk -- both land
    // on A. Merging into a collapsed bullet is normal and expected.
    const collapsed = buildTreeIndex([
      makeNode({
        id: "A",
        prevSiblingId: null,
        text: "alpha",
        collapsed: true,
      }),
      makeNode({ id: "a1", parentId: "A", prevSiblingId: null, text: "one" }),
      makeNode({ id: "B", prevSiblingId: "A", text: "bravo" }),
    ]);
    expect(
      planJoinPrevious(collapsed, "B", null, show, null, false),
    ).toMatchObject({ kind: "join", targetKey: "A", seamOffset: 5 });
  });

  test("seamOffset is SOURCE-space length, folded tokens counted in full", () => {
    // The target renders as "docs" (a folded link) but its source is the whole
    // markdown -- the caret must land past all 24 characters (ADR 0005).
    const src = "see [docs](https://x.com)";
    const withLink = buildTreeIndex([
      makeNode({ id: "L", prevSiblingId: null, text: src }),
      makeNode({ id: "M", prevSiblingId: "L", text: "tail" }),
    ]);
    const plan = planJoinPrevious(withLink, "M", null, show, null, false);
    expect(plan).toMatchObject({ kind: "join", seamOffset: src.length });
  });

  test("under a zoom root the first child's target is the ROOT's own title key", () => {
    const plan = planJoinPrevious(index, "a2", "A", show, null, false);
    expect(plan).toMatchObject({ kind: "join", targetKey: "a1" });
    expect(planJoinPrevious(index, "a1", "A", show, null, false)).toMatchObject(
      {
        kind: "join",
        targetKey: "A",
        seamOffset: 5,
      },
    );
  });
});

describe("planJoinPrevious — refusals", () => {
  const tree = [
    makeNode({ id: "A", prevSiblingId: null, text: "alpha" }),
    makeNode({ id: "a1", parentId: "A", prevSiblingId: null, text: "one" }),
    makeNode({ id: "B", prevSiblingId: "A", text: "bravo" }),
  ];
  const index = buildTreeIndex(tree);

  test("has-children: a bullet with children is refused, never reparented", () => {
    expect(planJoinPrevious(index, "A", null, show, null, false)).toEqual({
      kind: "refuse",
      reason: "has-children",
    });
  });

  test("no-target: the very first row, unzoomed", () => {
    const first = buildTreeIndex([
      makeNode({ id: "A", prevSiblingId: null, text: "alpha" }),
      makeNode({ id: "B", prevSiblingId: "A", text: "bravo" }),
    ]);
    expect(planJoinPrevious(first, "A", null, show, null, false)).toEqual({
      kind: "refuse",
      reason: "no-target",
    });
  });

  test("no-target: the zoom ROOT itself has no row above it", () => {
    // The root is prepended to the walk sequence, so it is index 0 -- there is
    // nothing above the title. (Its first child, by contrast, joins INTO it.)
    const leafRoot = buildTreeIndex([
      makeNode({ id: "R", prevSiblingId: null, text: "root" }),
      makeNode({ id: "r1", parentId: "R", prevSiblingId: null, text: "kid" }),
    ]);
    expect(
      planJoinPrevious(leafRoot, "r1", "R", show, null, false),
    ).toMatchObject({ kind: "join", targetKey: "R" });
    // The root row would refuse on has-children first; a childless root can't be
    // a zoom root, so no-target above the title is unreachable by construction.
    expect(planJoinPrevious(leafRoot, "R", "R", show, null, false)).toEqual({
      kind: "refuse",
      reason: "has-children",
    });
  });

  test("no-target: an unknown row key", () => {
    expect(planJoinPrevious(index, "ghost", null, show, null, false)).toEqual({
      kind: "refuse",
      reason: "no-target",
    });
  });

  test("hidden-between: hide-completed is hiding the true neighbor", () => {
    // A "alpha" / C "done" (completed) / B "bravo". With hide-completed on, B's
    // visible predecessor is A, but structurally it's C -- merging into A would
    // silently jump the text over a node the user can't see.
    const withDone = buildTreeIndex([
      makeNode({ id: "A", prevSiblingId: null, text: "alpha" }),
      makeNode({
        id: "C",
        prevSiblingId: "A",
        text: "done",
        completed: true,
      }),
      makeNode({ id: "B", prevSiblingId: "C", text: "bravo" }),
    ]);
    expect(
      planJoinPrevious(withDone, "B", null, hideCompleted, null, false),
    ).toEqual({ kind: "refuse", reason: "hidden-between" });
    // ...and with hide-completed OFF the same press merges into C.
    expect(
      planJoinPrevious(withDone, "B", null, show, null, false),
    ).toMatchObject({ kind: "join", targetKey: "C" });
  });

  test("hidden-between: a `?q=` filter pruned the true neighbor out of the view", () => {
    // A #go / N (no tag) / B #go. Under `#go`, B's visible predecessor is A;
    // structurally it's N.
    const t = [
      makeNode({ id: "A", prevSiblingId: null, text: "alpha #go" }),
      makeNode({ id: "N", prevSiblingId: "A", text: "nope" }),
      makeNode({ id: "B", prevSiblingId: "N", text: "bravo #go" }),
    ];
    const i = buildTreeIndex(t);
    const filter = buildQueryFilter(
      i,
      null,
      "#go",
      show,
      buildFilterOperatorMap([]),
    )!;
    expect(planJoinPrevious(i, "B", null, show, filter, false)).toEqual({
      kind: "refuse",
      reason: "hidden-between",
    });
  });

  test("negative control: two ADJACENT matches under an active filter still join", () => {
    const t = [
      makeNode({ id: "A", prevSiblingId: null, text: "alpha #go" }),
      makeNode({ id: "B", prevSiblingId: "A", text: "bravo #go" }),
      makeNode({ id: "N", prevSiblingId: "B", text: "nope" }),
    ];
    const i = buildTreeIndex(t);
    const filter = buildQueryFilter(
      i,
      null,
      "#go",
      show,
      buildFilterOperatorMap([]),
    )!;
    expect(planJoinPrevious(i, "B", null, show, filter, false)).toMatchObject({
      kind: "join",
      targetKey: "A",
      seamOffset: "alpha #go".length,
      sourceText: "bravo #go",
    });
  });

  test("mirror-row: the row being merged AWAY is a mirror instance", () => {
    // M mirrors S: its text is S's, which survives the join -- merging would
    // duplicate the text rather than move it.
    const t = [
      makeNode({ id: "S", prevSiblingId: null, text: "source" }),
      makeNode({ id: "A", prevSiblingId: "S", text: "alpha" }),
      makeNode({ id: "M", prevSiblingId: "A", mirrorOf: "S" }),
    ];
    const i = buildTreeIndex(t);
    expect(planJoinPrevious(i, "M", null, show, null, true)).toEqual({
      kind: "refuse",
      reason: "mirror-row",
    });
    // Off the mirrors flag a `mirrorOf` node is just a normal (empty) node.
    expect(planJoinPrevious(i, "M", null, show, null, false)).toMatchObject({
      kind: "join",
      targetKey: "A",
      sourceText: "",
    });
  });

  test("a mirror as the TARGET is allowed (appending edits the shared source)", () => {
    const t = [
      makeNode({ id: "S", parentId: "H", prevSiblingId: null, text: "source" }),
      makeNode({ id: "H", prevSiblingId: null, text: "home", collapsed: true }),
      makeNode({ id: "M", prevSiblingId: "H", mirrorOf: "S" }),
      makeNode({ id: "B", prevSiblingId: "M", text: "bravo" }),
    ];
    const i = buildTreeIndex(t);
    expect(planJoinPrevious(i, "B", null, show, null, true)).toMatchObject({
      kind: "join",
      targetKey: "M",
      targetId: "M",
      targetContentId: "S",
      seamOffset: "source".length,
      sourceText: "bravo",
    });
  });

  test("an EMPTY row above is removed instead — this node keeps its identity", () => {
    // The Enter-at-start shape (#326): a blank sibling sits above the node the
    // user is editing. Appending onto the blank would move the text (and every
    // bookmark / [[link]] / daily mapping) onto the blank's id; removing the
    // blank is the same thing on screen with identity left alone.
    const t = [
      makeNode({ id: "blank", prevSiblingId: null, text: "" }),
      makeNode({ id: "S", prevSiblingId: "blank", text: "hello" }),
    ];
    const i = buildTreeIndex(t);
    expect(planJoinPrevious(i, "S", null, show, null, false)).toEqual({
      kind: "remove-empty-target",
      targetKey: "blank",
      targetId: "blank",
      targetContentId: "blank",
    });
  });

  test("a WHITESPACE-only row above is a normal join, not a removal", () => {
    // Only genuinely empty counts. A row holding a space is content the user
    // typed, so it merges the ordinary way and the seam lands after it.
    const t = [
      makeNode({ id: "sp", prevSiblingId: null, text: " " }),
      makeNode({ id: "S", prevSiblingId: "sp", text: "hello" }),
    ];
    const i = buildTreeIndex(t);
    expect(planJoinPrevious(i, "S", null, show, null, false)).toMatchObject({
      kind: "join",
      targetId: "sp",
      seamOffset: 1,
      sourceText: "hello",
    });
  });

  test("a mirror of THIS node directly above it can't produce a self-join", () => {
    // M mirrors S and renders immediately above it, so the target's CONTENT
    // resolves back to S -- the source. Applied literally that plan would be
    // setText(S, …) then removeNode(S): the node and its text both gone. The
    // shell's guardMirrorSourceDelete refuses first today, but the planner must
    // never hand out a write-then-delete of the same node in the first place.
    const t = [
      makeNode({ id: "M", prevSiblingId: null, mirrorOf: "S" }),
      makeNode({ id: "S", prevSiblingId: "M", text: "source" }),
    ];
    const i = buildTreeIndex(t);
    expect(planJoinPrevious(i, "S", null, show, null, true)).toEqual({
      kind: "refuse",
      reason: "mirror-row",
    });
  });
});
