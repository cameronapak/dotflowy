import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

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

test.describe("keyboard move edge: reparent into parent's sibling", () => {
  test("move up at the top edge lands as the last child of the parent's previous sibling", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await page.goto("/");
    await text(page, "first").click();
    await page.keyboard.press(`${modifier()}+Shift+ArrowUp`);

    await expect(nestedUnder(page, "uncle", "first")).toBeVisible();
    await expect(nestedUnder(page, "parent", "first")).toHaveCount(0);
    await expect(text(page, "first")).toBeFocused();
  });

  test("move down at the bottom edge lands as the first child of the parent's next sibling", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await page.goto("/");
    await text(page, "last").click();
    await page.keyboard.press(`${modifier()}+Shift+ArrowDown`);

    await expect(nestedUnder(page, "aunt", "last")).toBeVisible();
    await expect(nestedUnder(page, "parent", "last")).toHaveCount(0);
    await expect(text(page, "last")).toBeFocused();
  });

  // Invariant: a reparent (move/outdent/drag) unmounts OutlineNodeBody at the
  // old position and mounts a fresh contentEditable span at the new one, then
  // re-focuses it. The moved node must keep showing its own text. The previous
  // tests here only checked placement + focus, never text content -- so they
  // would pass even with a blanked span (an empty contentEditable is still
  // "visible" and focusable). This locks the text-survival invariant directly.
  // (`first` is seeded with a child so both the parent and its subtree exercise
  // the remount path.) See ADR 0014.
  for (const move of [
    {
      id: "first",
      key: `${modifier()}+Shift+ArrowUp`,
      label: "move up",
    },
    {
      id: "last",
      key: `${modifier()}+Shift+ArrowDown`,
      label: "move down",
    },
  ] as const) {
    test(`${move.label}: the moved node keeps its own text while focused`, async ({
      page,
    }) => {
      await seedOutline(page, TREE);
      await page.goto("/");
      await text(page, move.id).click();
      await page.keyboard.press(move.key);

      await expect(text(page, move.id)).toBeFocused();
      await expect(text(page, move.id)).toHaveText(move.id);
    });
  }
});
