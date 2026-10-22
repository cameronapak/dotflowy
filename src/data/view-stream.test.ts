import { describe, expect, test } from "bun:test";

import { buildTreeIndex, createNode, type TreeIndex } from "./tree";
import {
  buildStream,
  type EmptySectionMode,
  type StreamSection,
  type ViewStream,
} from "./view-stream";

// Sections a..e. a has writing, b exists but holds only a blank line, c and d
// have no node, e is the pinned anchor with no node.
const tree = [
  createNode({ id: "A", prevSiblingId: null }),
  createNode({ id: "B", prevSiblingId: "A" }),
  createNode({ id: "a1", parentId: "A", prevSiblingId: null, text: "Walk" }),
  createNode({ id: "b1", parentId: "B", prevSiblingId: null, text: "" }),
];
const index = buildTreeIndex(tree);
const ids = new Map([
  ["a", "A"],
  ["b", "B"],
]);

function stream(emptyMode: EmptySectionMode): ViewStream {
  return {
    anchor: "e",
    emptyMode,
    keys: () => ({ keys: [], atStart: true, atEnd: true }),
    offsetOf: () => null,
    resolve: (key) => ids.get(key) ?? null,
    isEmpty: (key, idx: TreeIndex) =>
      key !== "a" || !idx.byId.has(ids.get(key) ?? ""),
    pinned: (key) => key === "e",
    placeholderTitle: (key) => key,
    badge: () => null,
    foldLabel: (keys) => keys.join(","),
    trailFor: () => null,
    create: async () => null,
  };
}

const keys = ["a", "b", "c", "d", "e"];
const layout = (sections: StreamSection[]) =>
  sections.map((s) =>
    s.kind === "fold" ? `fold(${s.keys.join(",")})` : `${s.kind}:${s.key}`,
  );
const build = (mode: EmptySectionMode, expanded: string[] = []) =>
  buildStream(index, stream(mode), keys, () => false, false, new Set(expanded));

describe("buildStream", () => {
  test("show keeps every section; nodeless ones become placeholders", () => {
    const out = build("show");
    expect(layout(out.sections)).toEqual([
      "node:a",
      "node:b",
      "placeholder:c",
      "placeholder:d",
      "placeholder:e",
    ]);
    expect(out.rows.map((r) => r.id)).toEqual(["a1", "b1"]);
    expect(out.rowSection.get("b1")).toBe("b");
  });

  test("fold groups a run of empty sections, sparing the pinned anchor", () => {
    expect(layout(build("fold").sections)).toEqual([
      "node:a",
      "fold(b,c,d)",
      "placeholder:e",
    ]);
  });

  test("an expanded section splits its fold", () => {
    expect(layout(build("fold", ["c"]).sections)).toEqual([
      "node:a",
      "fold(b)",
      "placeholder:c",
      "fold(d)",
      "placeholder:e",
    ]);
  });

  test("skip drops empty sections and their rows", () => {
    const out = build("skip");
    expect(layout(out.sections)).toEqual(["node:a", "placeholder:e"]);
    expect(out.rows.map((r) => r.id)).toEqual(["a1"]);
  });
});
