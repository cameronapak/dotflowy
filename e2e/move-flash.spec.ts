import { expect, test, type Page } from "@playwright/test";

import {
  placeCaret,
  seedOutline,
  STANDARD_TREE,
  type SeedNode,
} from "./fixtures";

// A node's OWN editable text span and its row (see move-dialog.spec.ts).
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
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

test('"Go" focuses and flashes the moved node in the destination view', async ({
  page,
}) => {
  await load(page, TREE);
  await openMove(page, "loose");
  await page.getByRole("dialog").getByRole("option", { name: "Inbox" }).click();

  // The confirming toast offers a "Go" action; clicking it zooms into Inbox.
  await page.getByRole("button", { name: "Go" }).click();
  await expect(page).toHaveURL(/\/inbox/);

  // The moved node lands focused -- "focused with that background".
  await expect(text(page, "loose")).toBeFocused();

  // ...and its row carries the one-shot flash class, bound to the fade
  // animation (confirms the relative-color keyframe parsed and the class is
  // wired through requestFlashAfterNav -> consumeFlashAfterNav -> flashRow).
  const moved = row(page, "loose");
  await expect(moved).toHaveClass(/node-acted/);
  await expect(moved).toHaveCSS("animation-name", "node-acted-fade");

  // The class clears itself when the animation ends (so it can re-trigger).
  await expect(moved).not.toHaveClass(/node-acted/, { timeout: 4000 });
});

test("a keyboard move (Cmd+Shift+Down) flashes the moved row", async ({
  page,
}) => {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible();

  // Focus alpha and nudge it past bravo among the top-level siblings.
  await text(page, "alpha").click();
  await expect(text(page, "alpha")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");

  // It moved (now after bravo) and the moved row flashes, focus intact.
  await expect(text(page, "alpha")).toBeFocused();
  await expect(row(page, "alpha")).toHaveClass(/node-acted/);
});
