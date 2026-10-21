import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  STANDARD_TREE,
  type SeedNode,
} from "./fixtures";

// A node's OWN editable text span (see move-dialog.spec.ts).
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await openSeededOutline(page, { anchorId: tree[0]!.id });
}

async function openMove(page: Page, id: string) {
  await placeCaret(text(page, id), "end");
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(" /move");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
}

const TREE: SeedNode[] = [
  {
    id: "inbox",
    parentId: null,
    prevSiblingId: null,
    text: "Inbox",
    bookmarkedAt: 100,
  },
  { id: "loose", parentId: null, prevSiblingId: "inbox", text: "Loose note" },
];

test('"Go" focuses the moved node in the destination view', async ({
  page,
}) => {
  await load(page, TREE);
  await openMove(page, "loose");
  await page.getByRole("dialog").getByRole("option", { name: "Inbox" }).click();

  // The confirming toast offers a "Go" action; clicking it zooms into Inbox.
  await page.getByRole("button", { name: "Go" }).click();
  await expect(page).toHaveURL(/\/inbox/);

  await expect(text(page, "loose")).toBeFocused();
});

test("a keyboard move (Cmd+Shift+Down) reorders siblings and keeps focus", async ({
  page,
}) => {
  await load(page, STANDARD_TREE);

  // Focus alpha and nudge it past bravo among the top-level siblings.
  await text(page, "alpha").click();
  await expect(text(page, "alpha")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");

  // It moved (now after bravo), focus intact.
  await expect
    .poll(() =>
      page
        .locator("li[data-node-id]:not([data-parent-id])")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-node-id")),
        ),
    )
    .toEqual(["bravo", "alpha", "charlie"]);
  await expect(text(page, "alpha")).toBeFocused();
});
