import { expect, test, type Page } from "@playwright/test";

import {
  placeCaret,
  seedOutline,
  text,
  type ApiNode,
  type SeedNode,
} from "./fixtures";

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

test("a move publishes one complete chain, undoes, and survives rollback and reload", async ({
  page,
}) => {
  const server = await seedOutline(page, TREE);
  await page.goto("/");
  await placeCaret(text(page, "uncle"), "end");
  await page.evaluate(async () => {
    const path = "/src/data/collection.ts";
    const { nodesCollection } = await import(path);
    nodesCollection.subscribeChanges((changes: { key: string }[]) => {
      if (!document.documentElement.dataset.moveBatch)
        document.documentElement.dataset.moveBatch = JSON.stringify(
          changes.map((c) => c.key).sort(),
        );
    });
  });
  const saved = (): Promise<ApiNode[]> =>
    page.evaluate(async () => (await fetch("/api/nodes")).json());
  const authoring = (rows: ApiNode[]) =>
    rows
      .map((n) => ({ ...n, updatedAt: 0 }))
      .sort((a, b) => a.id.localeCompare(b.id));
  const original = authoring(await saved());
  const moved = original.map((n) =>
    n.id === "uncle"
      ? { ...n, prevSiblingId: "parent" }
      : n.id === "parent"
        ? { ...n, prevSiblingId: null }
        : n.id === "aunt"
          ? { ...n, prevSiblingId: "uncle" }
          : n,
  );
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
  // Three changed pointers must reach subscribers together, not three full-tree
  // invalidations with a transient broken chain between them.
  await expect(page.locator("html")).toHaveAttribute(
    "data-move-batch",
    JSON.stringify(["aunt", "parent", "uncle"]),
  );
  await expect.poll(async () => authoring(await saved())).toEqual(moved);
  await expect(text(page, "uncle")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => authoring(await saved())).toEqual(original);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/history.ts";
        return (await import(path)).getHistoryState().busy;
      }),
    )
    .toBe(false);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await page.getByRole("option", { name: /^Redo move/ }).click();
  await expect.poll(async () => authoring(await saved())).toEqual(moved);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/history.ts";
        return (await import(path)).getHistoryState().busy;
      }),
    )
    .toBe(false);
  server.failNextWrite();
  await placeCaret(text(page, "uncle"), "end");
  const failure = page.waitForResponse(
    (r) => r.url().includes("/api/nodes") && r.status() === 500,
  );
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
  await failure;
  await expect
    .poll(() =>
      page
        .locator('li[data-depth="0"]')
        .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-node-id"))),
    )
    .toEqual(["parent", "uncle", "aunt"]);
  expect(authoring(await saved())).toEqual(moved);
  await page.reload();
  await text(page, "uncle").waitFor();
  expect(authoring(await saved())).toEqual(moved);
  await expect(text(page, "grandchild")).toHaveText("grandchild");
});
