import { expect, test, type Page } from "@playwright/test";

import { seedOutline, text, type SeedNode } from "./fixtures";

// "nodeId is a child of ancestorId", asserted via the row's data-parent-id (the
// node's real parent) rather than DOM nesting -- the flat windowed render has no
// nested <li>s (ADR 0019). nestedUnder(parent, x).toHaveCount(0) still reads as
// "x is no longer a direct child of parent".
const nestedUnder = (page: Page, ancestorId: string, nodeId: string) =>
  page.locator(`li[data-node-id="${nodeId}"][data-parent-id="${ancestorId}"]`);

/**
 *   - Uncle
 *       - existing
 *   - Parent
 *       - first
 *           - grandchild
 *       - last
 *   - Aunt
 *       - cousin
 */
const TREE: SeedNode[] = [
  { id: "uncle", parentId: null, prevSiblingId: null, text: "Uncle" },
  { id: "parent", parentId: null, prevSiblingId: "uncle", text: "Parent" },
  { id: "aunt", parentId: null, prevSiblingId: "parent", text: "Aunt" },
  {
    id: "existing",
    parentId: "uncle",
    prevSiblingId: null,
    text: "existing",
  },
  { id: "first", parentId: "parent", prevSiblingId: null, text: "first" },
  {
    id: "grandchild",
    parentId: "first",
    prevSiblingId: null,
    text: "grandchild",
  },
  { id: "last", parentId: "parent", prevSiblingId: "first", text: "last" },
  { id: "cousin", parentId: "aunt", prevSiblingId: null, text: "cousin" },
];

test("move up at the top edge lands as the last child of the parent's previous sibling", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/");
  await text(page, "first").click();
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");

  await expect(nestedUnder(page, "uncle", "first")).toBeVisible();
  await expect(nestedUnder(page, "parent", "first")).toHaveCount(0);
  await expect(text(page, "first")).toBeFocused();
  // Reparenting remounts the editor; focus alone would pass for a blank span.
  await expect(text(page, "first")).toHaveText("first");
});

test("move down at the bottom edge lands as the first child of the parent's next sibling", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/");
  await text(page, "last").click();
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");

  await expect(nestedUnder(page, "aunt", "last")).toBeVisible();
  await expect(nestedUnder(page, "parent", "last")).toHaveCount(0);
  await expect(text(page, "last")).toBeFocused();
  await expect(text(page, "last")).toHaveText("last");
});
