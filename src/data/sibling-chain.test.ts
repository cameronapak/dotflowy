import { expect, test } from "bun:test";

import { chainDisagreements, orderSiblings } from "./sibling-chain";
import { createNode } from "./tree";

type Link = [id: string, prev: string | null];
const nodes = (links: Link[]) =>
  links.map(([id, prevSiblingId]) => createNode({ id, prevSiblingId }));

test.each<[string, Link[], string[]]>([
  ["no children", [], []],
  ["one child", [["solo", null]], ["solo"]],
  [
    "a chain fed out of order follows prevSiblingId",
    [
      ["c", "b"],
      ["a", null],
      ["b", "a"],
    ],
    ["a", "b", "c"],
  ],
  [
    "a dangling pointer is appended, never dropped",
    [
      ["x", null],
      ["y", "ghost"],
    ],
    ["x", "y"],
  ],
  [
    // d wins the null-head fan; the a→b→n1→n2→c paste block still reads in
    // link order, not scrambled collection order.
    "an orphan subchain keeps link order when the fan winner arrives first",
    [
      ["d", null],
      ["n2", "n1"],
      ["c", "n2"],
      ["n1", "b"],
      ["a", null],
      ["b", "a"],
    ],
    ["d", "a", "b", "n1", "n2", "c"],
  ],
  [
    "an orphan subchain keeps link order when the fan winner arrives last",
    [
      ["n2", "n1"],
      ["c", "n2"],
      ["n1", "b"],
      ["a", null],
      ["b", "a"],
      ["d", null],
    ],
    ["a", "b", "n1", "n2", "c", "d"],
  ],
])("orderSiblings: %s", (_name, links, expected) => {
  expect(orderSiblings(nodes(links)).map((n) => n.id)).toEqual(expected);
});

test.each<[string, Link[]]>([
  [
    "a fan keeps both siblings",
    [
      ["a", null],
      ["b", null],
    ],
  ],
  [
    "a cycle terminates and keeps every node",
    [
      ["a", "b"],
      ["b", "a"],
    ],
  ],
])("orderSiblings: %s", (_name, links) => {
  const ordered = orderSiblings(nodes(links));
  expect(ordered.length).toBe(2);
  expect(new Set(ordered.map((n) => n.id))).toEqual(new Set(["a", "b"]));
});

test.each<[string, Link[], ReturnType<typeof chainDisagreements>]>([
  [
    "a correct chain has none",
    [
      ["a", null],
      ["b", "a"],
      ["c", "b"],
    ],
    [],
  ],
  [
    "the head must point at null",
    [
      ["a", "stale"],
      ["b", "a"],
    ],
    [{ id: "a", expectedPrev: null, actualPrev: "stale" }],
  ],
  [
    "every node whose stored prev disagrees with its position",
    [
      ["a", null],
      ["b", null],
      ["c", "a"],
    ],
    [
      { id: "b", expectedPrev: "a", actualPrev: null },
      { id: "c", expectedPrev: "b", actualPrev: "a" },
    ],
  ],
])("chainDisagreements: %s", (_name, links, expected) => {
  expect(chainDisagreements(nodes(links))).toEqual(expected);
});
