import { expect, test, type Page } from "@playwright/test";
import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// A node's OWN editable text span (see keyboard-nav.spec.ts for the `>` chain).
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

/**
 * Open the `/move` dialog for a node the way a user does: focus the bullet, type
 * the slash command, and Enter to run it. A click lands the caret past the
 * bullet text, so the " /" follows whitespace and `detectSlash` fires (a "/"
 * mid-word would be ignored, e.g. a URL). See slash-menu.tsx.
 */
async function openMove(page: Page, id: string) {
  await text(page, id).click();
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(" /move");
  await expect(page.getByRole("listbox")).toBeVisible(); // the slash menu
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
}

// inbox + projects are bookmarked; archive + loose are not. proj-a is a child of
// projects so we can exercise subtree exclusion.
const BOOKMARKED_TREE: SeedNode[] = [
  { id: "inbox", parentId: null, prevSiblingId: null, text: "Inbox", bookmarkedAt: 100 },
  { id: "projects", parentId: null, prevSiblingId: "inbox", text: "Projects", bookmarkedAt: 200 },
  { id: "archive", parentId: null, prevSiblingId: "projects", text: "Archive" },
  { id: "loose", parentId: null, prevSiblingId: "archive", text: "Loose note" },
  { id: "proj-a", parentId: "projects", prevSiblingId: null, text: "Project A" },
];

test.describe("move dialog: bookmark empty state", () => {
  test("empty query lists only bookmarked nodes as destinations", async ({
    page,
  }) => {
    await load(page, BOOKMARKED_TREE);
    await openMove(page, "loose");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Bookmarks")).toBeVisible();

    // The two bookmarked nodes are offered...
    await expect(dialog.getByRole("option", { name: "Inbox" })).toBeVisible();
    await expect(
      dialog.getByRole("option", { name: "Projects" }),
    ).toBeVisible();

    // ...the un-bookmarked ones (incl. the node being moved) are not.
    await expect(dialog.getByRole("option", { name: "Archive" })).toHaveCount(0);
    await expect(
      dialog.getByRole("option", { name: "Loose note" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("option", { name: "Project A" }),
    ).toHaveCount(0);

    // Home is always available as a top-level destination.
    await expect(dialog.getByRole("option", { name: "Home" })).toBeVisible();
  });

  test("picking a bookmark reparents the node under it", async ({ page }) => {
    await load(page, BOOKMARKED_TREE);
    await openMove(page, "loose");

    await page.getByRole("dialog").getByRole("option", { name: "Inbox" }).click();

    // Confirming toast names the destination.
    await expect(page.getByText("Moved to Inbox")).toBeVisible();

    // And the node is now a child of Inbox (its data-parent-id), not top-level.
    await expect(
      page.locator('li[data-node-id="loose"][data-parent-id="inbox"]'),
    ).toBeVisible();
  });

  test("the moved node and its own subtree are excluded from bookmarks", async ({
    page,
  }) => {
    // Bookmark projects AND its child proj-a, then move projects: neither itself
    // nor its descendant may be offered (you can't move a branch into itself),
    // but a sibling bookmark still can.
    const tree: SeedNode[] = [
      { id: "inbox", parentId: null, prevSiblingId: null, text: "Inbox", bookmarkedAt: 100 },
      { id: "projects", parentId: null, prevSiblingId: "inbox", text: "Projects", bookmarkedAt: 200 },
      { id: "loose", parentId: null, prevSiblingId: "projects", text: "Loose note" },
      { id: "proj-a", parentId: "projects", prevSiblingId: null, text: "Project A", bookmarkedAt: 300 },
    ];
    await load(page, tree);
    await openMove(page, "projects");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("option", { name: "Inbox" })).toBeVisible();
    await expect(
      dialog.getByRole("option", { name: "Projects" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("option", { name: "Project A" }),
    ).toHaveCount(0);
  });

  test("with no bookmarks: a hint shows and typing falls back to search", async ({
    page,
  }) => {
    await load(page, STANDARD_TREE); // STANDARD_TREE bookmarks nothing
    await openMove(page, "charlie");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Type to search your nodes")).toBeVisible();
    await expect(dialog.getByRole("option", { name: "Home" })).toBeVisible();

    // Typing runs the full fuzzy search over every node.
    await page.keyboard.type("alpha");
    await expect(dialog.getByRole("option", { name: "Alpha", exact: true })).toBeVisible();
    await expect(
      dialog.getByText("Type to search your nodes"),
    ).toHaveCount(0);
  });
});
