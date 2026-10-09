import { expect, test } from "bun:test";

import { outlineToMarkdown } from "./markdown";
import { buildTreeIndex, createNode, type Node } from "./tree";

test.each<[string, Node[], string[], string]>([
  [
    "nests children two spaces per level under the root bullet",
    [
      createNode({ id: "root", text: "root" }),
      createNode({ id: "child", parentId: "root", text: "child" }),
      createNode({ id: "gc", parentId: "child", text: "grandchild" }),
    ],
    ["root"],
    ["- root", "  - child", "    - grandchild"].join("\n"),
  ],
  [
    "orders siblings by the prevSiblingId chain, not input order",
    [
      createNode({ id: "b", parentId: "root", prevSiblingId: "a", text: "b" }),
      createNode({ id: "root", text: "root" }),
      createNode({ id: "a", parentId: "root", prevSiblingId: null, text: "a" }),
    ],
    ["root"],
    ["- root", "  - a", "  - b"].join("\n"),
  ],
  [
    "renders tasks as GFM checkboxes by completion",
    [
      createNode({ id: "o", isTask: true, completed: false, text: "open" }),
      createNode({ id: "d", isTask: true, completed: true, text: "done" }),
    ],
    ["o", "d"],
    ["- [ ] open", "- [x] done"].join("\n"),
  ],
  [
    "emits markdown source for links, tags, and code",
    [createNode({ id: "n", text: "see [docs](https://x.dev) #ref `code`" })],
    ["n"],
    "- see [docs](https://x.dev) #ref `code`",
  ],
  [
    "exports route-bible references as readable markdown links",
    [createNode({ id: "n", text: "Read John 3:16 and Genesis 1" })],
    ["n"],
    "- Read [John 3:16](https://route.bible/jhn.3.16?src=dotflowy) and [Genesis 1](https://route.bible/gen.1?src=dotflowy)",
  ],
  [
    "does not relink route-bible references inside existing links or code",
    [
      createNode({
        id: "n",
        text: "see [John 3:16](https://example.com) and `Romans 8:28`",
      }),
    ],
    ["n"],
    "- see [John 3:16](https://example.com) and `Romans 8:28`",
  ],
  [
    "includes collapsed and completed nodes (full fidelity, ignores view)",
    [
      createNode({ id: "root", text: "root", collapsed: true }),
      createNode({
        id: "h",
        parentId: "root",
        text: "still here",
        isTask: true,
        completed: true,
      }),
    ],
    ["root"],
    ["- root", "  - [x] still here"].join("\n"),
  ],
  [
    "an empty node is a bare bullet",
    [
      createNode({ id: "root", text: "" }),
      createNode({ id: "c", parentId: "root", text: "child" }),
    ],
    ["root"],
    ["- ", "  - child"].join("\n"),
  ],
  [
    "multiple roots serialize as adjacent top-level bullets",
    [
      createNode({ id: "a", prevSiblingId: null, text: "a" }),
      createNode({ id: "b", prevSiblingId: "a", text: "b" }),
      createNode({ id: "a1", parentId: "a", text: "a1" }),
    ],
    ["a", "b"],
    ["- a", "  - a1", "- b"].join("\n"),
  ],
  [
    "an unknown root id contributes nothing",
    [createNode({ id: "a", text: "a" })],
    ["ghost"],
    "",
  ],
])("outlineToMarkdown: %s", (_name, nodes, roots, expected) => {
  expect(outlineToMarkdown(buildTreeIndex(nodes), roots)).toBe(expected);
});
