import { describe, expect, test } from "bun:test";

import type { Node } from "../src/data/wire-schema";

import { createNode } from "../src/data/tree";
import { validateLockedPatches, validateLockedWrite } from "./lock-policy";

const update = (node: Node, changes: Partial<Node>) => ({
  op: "update" as const,
  value: { ...node, ...changes, updatedAt: node.updatedAt + 1 },
});

describe("locked node writes", () => {
  const root = createNode({ id: "root", locked: true });
  const child = createNode({ id: "child", parentId: "root", text: "before" });
  const sibling = createNode({ id: "sibling", prevSiblingId: "root" });

  test("allows moving a locked subtree intact", () => {
    expect(
      validateLockedWrite(
        [root, child, sibling],
        [update(root, { prevSiblingId: "sibling" })],
      ),
    ).toBeNull();
  });

  test("rejects descendant content edits and insertion", () => {
    expect(
      validateLockedWrite([root, child], [update(child, { text: "after" })]),
    ).toEqual({ reason: "Locked content cannot be changed." });
    const inserted = createNode({ id: "new", parentId: "root" });
    expect(
      validateLockedWrite([root, child], [{ op: "insert", value: inserted }]),
    ).toEqual({ reason: "Locked content cannot be changed." });
  });

  test("rejects deleting an unlocked ancestor containing a lock", () => {
    const parent = createNode({ id: "parent" });
    const nested = { ...root, parentId: "parent" };
    expect(
      validateLockedWrite(
        [parent, nested, child],
        [
          { op: "delete", key: "parent" },
          { op: "delete", key: "root" },
          { op: "delete", key: "child" },
        ],
      ),
    ).toEqual({ reason: "A locked node cannot be deleted." });
    expect(
      validateLockedWrite(
        [parent, nested, child],
        [{ op: "delete", key: "parent" }],
      ),
    ).toEqual({
      reason: "An ancestor of a locked node cannot be deleted.",
    });
  });

  test("allows collapse and bookmark view state", () => {
    expect(
      validateLockedWrite(
        [root, child],
        [update(child, { collapsed: true, bookmarkedAt: 123 })],
      ),
    ).toBeNull();
  });

  test("crosses mirrors", () => {
    const mirror = createNode({
      id: "mirror",
      parentId: "root",
      mirrorOf: "source",
    });
    const source = createNode({ id: "source", text: "before" });
    expect(
      validateLockedWrite(
        [root, mirror, source],
        [update(source, { text: "after" })],
      ),
    ).toEqual({ reason: "Locked content cannot be changed." });
  });

  test("allows separate editor lock transitions only", () => {
    const plain = createNode({ id: "plain" });
    const lock = update(plain, { locked: true });
    expect(validateLockedWrite([plain], [lock])).toEqual({
      reason: "Only the editor can change node locks.",
    });
    expect(validateLockedWrite([plain], [lock], true)).toBeNull();
    expect(
      validateLockedWrite(
        [plain],
        [update(plain, { locked: true, text: "also changed" })],
        true,
      ),
    ).toEqual({ reason: "Lock changes must be committed separately." });
  });

  test("rejects changing a nested direct lock while an outer lock applies", () => {
    const nested = createNode({
      id: "nested",
      parentId: "root",
      locked: true,
    });
    expect(
      validateLockedWrite(
        [root, nested],
        [update(nested, { locked: false })],
        true,
      ),
    ).toEqual({
      reason: "An inherited lock must be removed before changing this lock.",
    });
  });

  test("validates repeated patches as the cumulative row SQL will commit", () => {
    expect(
      validateLockedPatches(
        [root, child],
        [
          { id: "child", changes: { text: "hidden edit" } },
          { id: "child", changes: { collapsed: true } },
        ],
      ),
    ).toEqual({ reason: "Locked content cannot be changed." });

    const plain = createNode({ id: "plain" });
    expect(
      validateLockedPatches(
        [plain],
        [
          { id: "plain", changes: { text: "hidden edit" } },
          { id: "plain", changes: { locked: true } },
        ],
        true,
      ),
    ).toEqual({ reason: "Lock changes must be committed separately." });
  });

  test("protects physical ancestors of content locked through a mirror", () => {
    const locked = createNode({ id: "locked", locked: true });
    const mirror = createNode({
      id: "mirror",
      parentId: "locked",
      mirrorOf: "source",
    });
    const parent = createNode({ id: "parent", prevSiblingId: "locked" });
    const source = createNode({ id: "source", parentId: "parent" });

    expect(
      validateLockedWrite(
        [locked, mirror, parent, source],
        [{ op: "delete", key: "parent" }],
      ),
    ).toEqual({
      reason: "An ancestor of a locked node cannot be deleted.",
    });
  });
});
