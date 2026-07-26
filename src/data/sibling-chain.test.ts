import { describe, expect, test } from "bun:test";

import { chainDisagreements, orderSiblings } from "./sibling-chain";
import { makeNode } from "./tree";

describe("orderSiblings", () => {
  test("orders by the prevSiblingId chain, not input order", () => {
    // a -> b -> c, fed out of order
    const a = makeNode({ id: "a", prevSiblingId: null });
    const b = makeNode({ id: "b", prevSiblingId: "a" });
    const c = makeNode({ id: "c", prevSiblingId: "b" });
    expect(orderSiblings([c, a, b]).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  test("zero or one child is returned unchanged", () => {
    expect(orderSiblings([])).toEqual([]);
    expect(orderSiblings([makeNode({ id: "solo" })]).map((n) => n.id)).toEqual([
      "solo",
    ]);
  });

  test("a node orphaned by a dangling pointer is appended, never dropped", () => {
    const x = makeNode({ id: "x", prevSiblingId: null });
    // y points at a sibling that is not present -> off the chain
    const y = makeNode({ id: "y", prevSiblingId: "ghost" });
    expect(orderSiblings([x, y]).map((n) => n.id)).toEqual(["x", "y"]);
  });

  test("a fan keeps both siblings (one rides the chain, one is appended)", () => {
    // both claim the head -> one wins the walk, the other is orphan-appended
    const a = makeNode({ id: "a", prevSiblingId: null });
    const b = makeNode({ id: "b", prevSiblingId: null });
    const ordered = orderSiblings([a, b]);
    expect(ordered.length).toBe(2);
    expect(new Set(ordered.map((n) => n.id))).toEqual(new Set(["a", "b"]));
  });

  test("a cyclic chain terminates and keeps every node", () => {
    // a -> b -> a, no head: the iteration cap must stop the walk
    const a = makeNode({ id: "a", prevSiblingId: "b" });
    const b = makeNode({ id: "b", prevSiblingId: "a" });
    const ordered = orderSiblings([a, b]);
    expect(ordered.length).toBe(2);
    expect(new Set(ordered.map((n) => n.id))).toEqual(new Set(["a", "b"]));
  });

  test("orphan subchains keep paste order when a fan steals the null head", () => {
    // d wins the null-prev fan (last in the multimap's arrival list among heads
    // is not what matters — a is first among null claimants in this feed, but
    // d appears first so d wins). The a→b→n1→n2→c paste block must still read
    // in link order, not scrambled collection order.
    const nodes = [
      makeNode({ id: "d", prevSiblingId: null, text: "other-head" }),
      makeNode({ id: "n2", prevSiblingId: "n1", text: "paste2" }),
      makeNode({ id: "c", prevSiblingId: "n2", text: "after" }),
      makeNode({ id: "n1", prevSiblingId: "b", text: "paste1" }),
      makeNode({ id: "a", prevSiblingId: null, text: "anchor" }),
      makeNode({ id: "b", prevSiblingId: "a", text: "anchor-next" }),
    ];
    expect(orderSiblings(nodes).map((n) => n.id)).toEqual([
      "d",
      "a",
      "b",
      "n1",
      "n2",
      "c",
    ]);
  });

  test("orphan subchains survive when the fan winner is last in arrival order", () => {
    const nodes = [
      makeNode({ id: "n2", prevSiblingId: "n1", text: "paste2" }),
      makeNode({ id: "c", prevSiblingId: "n2", text: "after" }),
      makeNode({ id: "n1", prevSiblingId: "b", text: "paste1" }),
      makeNode({ id: "a", prevSiblingId: null, text: "anchor" }),
      makeNode({ id: "b", prevSiblingId: "a", text: "anchor-next" }),
      makeNode({ id: "d", prevSiblingId: null, text: "other-head" }),
    ];
    expect(orderSiblings(nodes).map((n) => n.id)).toEqual([
      "a",
      "b",
      "n1",
      "n2",
      "c",
      "d",
    ]);
  });
});

describe("chainDisagreements", () => {
  test("a correctly linked chain yields no disagreements", () => {
    const ordered = [
      makeNode({ id: "a", prevSiblingId: null }),
      makeNode({ id: "b", prevSiblingId: "a" }),
      makeNode({ id: "c", prevSiblingId: "b" }),
    ];
    expect(chainDisagreements(ordered)).toEqual([]);
  });

  test("the head must point at null", () => {
    const ordered = [
      makeNode({ id: "a", prevSiblingId: "stale" }),
      makeNode({ id: "b", prevSiblingId: "a" }),
    ];
    expect(chainDisagreements(ordered)).toEqual([
      { id: "a", expectedPrev: null, actualPrev: "stale" },
    ]);
  });

  test("reports every node whose stored prev disagrees with its position", () => {
    const ordered = [
      makeNode({ id: "a", prevSiblingId: null }),
      makeNode({ id: "b", prevSiblingId: null }), // should point at 'a'
      makeNode({ id: "c", prevSiblingId: "a" }), // should point at 'b'
    ];
    expect(chainDisagreements(ordered)).toEqual([
      { id: "b", expectedPrev: "a", actualPrev: null },
      { id: "c", expectedPrev: "b", actualPrev: "a" },
    ]);
  });
});
