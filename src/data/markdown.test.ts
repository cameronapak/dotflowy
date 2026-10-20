import { expect, test } from "bun:test";

import { outlineToMarkdown } from "./markdown";
import { buildTreeIndex, createNode } from "./tree";

test("exports ordered nested roots with tasks, empty nodes, and verbatim inline source, regardless of view state", () => {
  // Deliberately shuffled: the sibling chain, not insertion order, owns export.
  const index = buildTreeIndex([
    createNode({
      id: "done",
      parentId: "root",
      prevSiblingId: "open",
      text: "done",
      isTask: true,
      completed: true,
    }),
    createNode({ id: "other", prevSiblingId: "root", text: "other" }),
    createNode({ id: "root", text: "root", collapsed: true }),
    createNode({ id: "empty", parentId: "open", text: "" }),
    createNode({
      id: "source",
      parentId: "empty",
      text: "see [docs](https://x.dev) #ref `code`",
    }),
    createNode({ id: "open", parentId: "root", text: "open", isTask: true }),
  ]);
  expect(outlineToMarkdown(index, ["root", "other"])).toBe(
    [
      "- root",
      "  - [ ] open",
      "    - ",
      "      - see [docs](https://x.dev) #ref `code`",
      "  - [x] done",
      "- other",
    ].join("\n"),
  );
});

test.each([
  [
    "Read John 3:16 and Genesis 1",
    "- Read [John 3:16](https://route.bible/jhn.3.16?src=dotflowy) and [Genesis 1](https://route.bible/gen.1?src=dotflowy)",
  ],
  [
    "see [John 3:16](https://example.com) and `Romans 8:28`",
    "- see [John 3:16](https://example.com) and `Romans 8:28`",
  ],
])(
  "exports Bible references without relinking existing links or code: %p",
  (text, expected) => {
    const index = buildTreeIndex([createNode({ id: "n", text })]);
    expect(outlineToMarkdown(index, ["n"])).toBe(expected);
  },
);

test("an unknown root id contributes nothing", () => {
  const index = buildTreeIndex([createNode({ id: "a", text: "a" })]);
  expect(outlineToMarkdown(index, ["ghost"])).toBe("");
});
