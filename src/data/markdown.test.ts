import { expect, test } from "bun:test";

import { outlineToMarkdown } from "./markdown";
import { buildTreeIndex, createNode } from "./tree";

test("numbering uses full sibling runs and mirror instance positions, including partial copies", () => {
  const index = buildTreeIndex([
    createNode({
      id: "a",
      text: "first",
      kind: "numbered",
      completed: true,
      collapsed: true,
    }),
    createNode({
      id: "b",
      prevSiblingId: "a",
      text: "second",
      kind: "numbered",
      isTask: true,
    }),
    createNode({
      id: "break",
      prevSiblingId: "b",
      text: "prose",
      kind: "paragraph",
    }),
    createNode({
      id: "c",
      prevSiblingId: "break",
      text: "restart",
      kind: "numbered",
    }),
    createNode({ id: "mirror", prevSiblingId: "c", mirrorOf: "a" }),
    createNode({
      id: "child1",
      parentId: "a",
      text: "nested first",
      kind: "numbered",
    }),
    createNode({
      id: "child2",
      parentId: "a",
      prevSiblingId: "child1",
      text: "nested second",
      kind: "numbered",
    }),
  ]);
  expect(outlineToMarkdown(index, ["a", "b", "break", "c", "mirror"])).toBe(
    "1. first\n  1. nested first\n  2. nested second\n2. second\nprose\n1. restart\n2. first\n  1. nested first\n  2. nested second",
  );
  expect(outlineToMarkdown(index, ["b", "child2", "mirror"])).toBe(
    "2. second\n2. nested second\n2. first\n  1. nested first\n  2. nested second",
  );
});

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

test("exports node links as current target markdown without pulling in target children", () => {
  const targetId = "11111111-2222-3333-4444-555555555555";
  const nestedId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const mirrorId = "n_mirror_target";
  const missingId = "00000000-0000-0000-0000-000000000000";
  const index = buildTreeIndex([
    createNode({ id: "root", text: "Hours", isTask: true }),
    createNode({
      id: "child",
      parentId: "root",
      text: `Review [[${targetId}]] then [[${mirrorId}]]; [[${missingId}]]; [[not an id]]`,
    }),
    createNode({
      id: targetId,
      text: `**Docs** [PR](https://example.com/pr) for [[${nestedId}]]`,
    }),
    createNode({ id: nestedId, text: "DevRel" }),
    createNode({ id: mirrorId, mirrorOf: targetId }),
    createNode({
      id: "excluded",
      parentId: targetId,
      text: "Not linked content",
    }),
  ]);
  expect(outlineToMarkdown(index, ["root"])).toBe(
    "- [ ] Hours\n  - Review **Docs** [PR](https://example.com/pr) for DevRel then **Docs** [PR](https://example.com/pr) for DevRel; missing link; [[not an id]]",
  );

  index.byId.set(nestedId, {
    ...index.byId.get(nestedId)!,
    text: "Renamed DevRel",
  });
  expect(outlineToMarkdown(index, ["child"])).toContain("for Renamed DevRel");
  expect(index.byId.get("child")!.text).toContain(`[[${targetId}]]`);

  index.byId.set(nestedId, {
    ...index.byId.get(nestedId)!,
    text: `cycle [[${targetId}]]`,
  });
  expect(outlineToMarkdown(index, [targetId])).toBe(
    "- **Docs** [PR](https://example.com/pr) for cycle …\n  - Not linked content",
  );
});

test("an unknown root id contributes nothing", () => {
  const index = buildTreeIndex([createNode({ id: "a", text: "a" })]);
  expect(outlineToMarkdown(index, ["ghost"])).toBe("");
});
