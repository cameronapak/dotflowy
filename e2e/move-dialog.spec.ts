import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  type SeedNode,
} from "./fixtures";

// A node's OWN editable text span (see keyboard-nav.spec.ts for the `>` chain).
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await openSeededOutline(page, { anchorId: tree[0]!.id });
}

/**
 * Open the `/move` dialog for a node the way a user does: focus the bullet, type
 * the slash command, and Enter to run it. Place the caret past the
 * bullet text, so the " /" follows whitespace and `detectSlash` fires (a "/"
 * mid-word would be ignored, e.g. a URL). See slash-menu.tsx.
 */
async function openMove(page: Page, id: string) {
  await placeCaret(text(page, id), "end");
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(" /move");
  await expect(page.getByRole("listbox")).toBeVisible(); // the slash menu
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
}

// inbox + projects are bookmarked; archive + loose are not. proj-a is a child of
// projects so we can exercise subtree exclusion.
const BOOKMARKED_TREE: SeedNode[] = [
  {
    id: "inbox",
    parentId: null,
    prevSiblingId: null,
    text: "Inbox",
    bookmarkedAt: 100,
  },
  {
    id: "projects",
    parentId: null,
    prevSiblingId: "inbox",
    text: "Projects",
    bookmarkedAt: 200,
  },
  { id: "archive", parentId: null, prevSiblingId: "projects", text: "Archive" },
  { id: "loose", parentId: null, prevSiblingId: "archive", text: "Loose note" },
  {
    id: "proj-a",
    parentId: "projects",
    prevSiblingId: null,
    text: "Project A",
  },
];

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
    {
      id: "inbox",
      parentId: null,
      prevSiblingId: null,
      text: "Inbox",
      bookmarkedAt: 100,
    },
    {
      id: "projects",
      parentId: null,
      prevSiblingId: "inbox",
      text: "Projects",
      bookmarkedAt: 200,
    },
    {
      id: "loose",
      parentId: null,
      prevSiblingId: "projects",
      text: "Loose note",
    },
    {
      id: "proj-a",
      parentId: "projects",
      prevSiblingId: null,
      text: "Project A",
      bookmarkedAt: 300,
    },
  ];
  await load(page, tree);
  await openMove(page, "projects");

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("option", { name: "Inbox" })).toBeVisible();
  await expect(dialog.getByRole("option", { name: "Projects" })).toHaveCount(0);
  await expect(dialog.getByRole("option", { name: "Project A" })).toHaveCount(
    0,
  );
});
