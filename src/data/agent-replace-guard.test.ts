import { describe, expect, test } from "bun:test";

import { hashAnswerSubtree, shouldReplaceAnswer } from "./agent-replace-guard";
import { buildTreeIndex, makeNode } from "./tree";

function fixture() {
  const summary = makeNode({
    id: "sum",
    parentId: "q",
    text: "ISO weeks start Monday.",
    origin: "agent",
  });
  const detail = makeNode({
    id: "det",
    parentId: "sum",
    text: "Thursday decides the month.",
    collapsed: true,
    origin: "agent",
  });
  const q = makeNode({ id: "q", text: "@agent week?" });
  const index = buildTreeIndex([q, summary, detail]);
  return { summary, detail, index };
}

describe("hashAnswerSubtree", () => {
  test("stable for the same tree", () => {
    const { summary, index } = fixture();
    expect(hashAnswerSubtree(index, summary.id)).toBe(
      hashAnswerSubtree(index, summary.id),
    );
  });

  test("changes when text is edited", () => {
    const { summary, detail, index } = fixture();
    const before = hashAnswerSubtree(index, summary.id);
    const edited = buildTreeIndex([
      makeNode({ id: "q", text: "@agent week?" }),
      { ...summary, text: "edited by user" },
      detail,
    ]);
    expect(hashAnswerSubtree(edited, summary.id)).not.toBe(before);
  });

  test("changes when a child is added", () => {
    const { summary, detail, index } = fixture();
    const before = hashAnswerSubtree(index, summary.id);
    const grown = buildTreeIndex([
      makeNode({ id: "q", text: "@agent week?" }),
      summary,
      detail,
      makeNode({
        id: "extra",
        parentId: "sum",
        prevSiblingId: "det",
        text: "user note",
      }),
    ]);
    expect(hashAnswerSubtree(grown, summary.id)).not.toBe(before);
  });
});

describe("shouldReplaceAnswer", () => {
  test("replace when hash matches the stored snapshot", () => {
    const { summary, index } = fixture();
    const hash = hashAnswerSubtree(index, summary.id);
    expect(shouldReplaceAnswer(index, summary.id, hash)).toBe(true);
  });

  test("append (no replace) when subtree was touched", () => {
    const { summary, detail, index } = fixture();
    const hash = hashAnswerSubtree(index, summary.id);
    const touched = buildTreeIndex([
      makeNode({ id: "q", text: "@agent week?" }),
      { ...summary, text: "touched" },
      detail,
    ]);
    expect(shouldReplaceAnswer(touched, summary.id, hash)).toBe(false);
  });

  test("append when stored hash is null/missing root", () => {
    const { summary, index } = fixture();
    expect(shouldReplaceAnswer(index, summary.id, null)).toBe(false);
    expect(shouldReplaceAnswer(index, "missing", "abc")).toBe(false);
  });
});
