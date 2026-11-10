import { expect, test } from "bun:test";

import { numberedOrdinals } from "./numbering";
import { buildTreeIndex, childrenOf, createNode } from "./tree";

test("ordinals follow full sibling runs and mirror positions, independent of text and visibility", () => {
  const index = buildTreeIndex([
    createNode({
      id: "a",
      kind: "numbered",
      text: "not a marker",
      collapsed: true,
    }),
    createNode({
      id: "b",
      prevSiblingId: "a",
      kind: "numbered",
      completed: true,
    }),
    createNode({ id: "c", prevSiblingId: "b", kind: "paragraph" }),
    createNode({ id: "m", prevSiblingId: "c", mirrorOf: "b" }),
    createNode({ id: "d", prevSiblingId: "m", kind: "numbered" }),
    createNode({ id: "child", parentId: "b", kind: "numbered" }),
  ]);
  const siblings = childrenOf(index, null).map((n) => n.id);
  expect([...numberedOrdinals(index, siblings)]).toEqual([
    ["a", 1],
    ["b", 2],
    ["m", 1],
    ["d", 2],
  ]);
  expect([...numberedOrdinals(index, ["child"])]).toEqual([["child", 1]]);
  // Moving the paragraph changes run boundaries; the mirror still reads b's Kind.
  expect([...numberedOrdinals(index, ["a", "c", "b", "m", "d"])]).toEqual([
    ["a", 1],
    ["b", 1],
    ["m", 2],
    ["d", 3],
  ]);
});
