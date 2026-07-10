// Sliced history restore: undoing (or redoing) a snapshot diff of 500+
// collection writes streams through runStructuralSliced behind a modal
// progress dialog instead of freezing the main thread in one synchronous
// burst. Small undos stay synchronous and instant — the dialog never mounts.
// Either way the restore is ONE atomic batch that persists across reload.
import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

/** STANDARD_TREE plus a "big" top-level parent with `n` children — enough to
 *  cross the restore slice threshold (500). */
function bigSeed(n: number): SeedNode[] {
  const children: SeedNode[] = Array.from({ length: n }, (_, i) => ({
    id: `big-${i}`,
    parentId: "big",
    prevSiblingId: i === 0 ? null : `big-${i - 1}`,
    text: `big child ${i}`,
  }));
  return [
    ...STANDARD_TREE,
    {
      id: "big",
      parentId: null,
      prevSiblingId: "charlie",
      text: "Big parent",
      collapsed: true,
    },
    ...children,
  ];
}

/** Delete the 601-node "big" subtree through the confirm flow. */
async function bigDelete(page: Page) {
  await text(page, "big").click();
  await page.keyboard.press("ControlOrMeta+Shift+Backspace");
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("delete-confirm-dialog")).toHaveCount(0);
  await expect(page.locator('li[data-node-id="big"]')).toHaveCount(0);
}

test.describe("sliced history restore", () => {
  test("Cmd+Z after a big delete restores through the progress dialog and persists", async ({
    page,
  }) => {
    // Delay the batch POST response so the dialog rests in its post-apply
    // "saving" phase — proof every slice applied while ONE batch is in flight.
    await seedOutline(page, bigSeed(600), { postDelayMs: 400 });
    await page.goto("/");
    await expect(text(page, "big")).toBeVisible();

    await bigDelete(page);

    // Undo: the diff is 601 inserts (>= 500) -> the modal progress path.
    await text(page, "alpha").click();
    await expect(text(page, "alpha")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.getByTestId("history-restoring")).toContainText(
      "Saving 601 changes as one atomic batch.",
    );
    // The dialog closes itself once the batch's echo lands.
    await expect(page.getByTestId("history-restore-dialog")).toHaveCount(0);
    await expect(text(page, "big")).toBeVisible();

    // The restore batch persisted to the (mock) server store, not just the
    // optimistic overlay: a reload still shows the whole subtree.
    await page.reload();
    await expect(text(page, "big")).toBeVisible();
    await expect(text(page, "charlie")).toBeVisible();
    // The children are back too (collapsed rows don't render at home, so zoom
    // in; the windowed list only mounts the first screenful — big-0 suffices,
    // the 601-op batch is atomic so partial restore can't persist).
    await page.goto("/big");
    await expect(text(page, "big-0")).toBeVisible();
  });

  test("Cmd+Shift+Z re-applies the big delete through the same sliced path", async ({
    page,
  }) => {
    await seedOutline(page, bigSeed(600), { postDelayMs: 400 });
    await page.goto("/");
    await expect(text(page, "big")).toBeVisible();

    await bigDelete(page);

    // Undo brings the subtree back...
    await text(page, "alpha").click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.getByTestId("history-restore-dialog")).toHaveCount(0);
    await expect(text(page, "big")).toBeVisible();

    // ...and redo deletes it again, also sliced (601 deletes >= 500).
    await text(page, "alpha").click();
    await expect(text(page, "alpha")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(page.getByTestId("history-restoring")).toBeVisible();
    await expect(page.getByTestId("history-restore-dialog")).toHaveCount(0);
    await expect(page.locator('li[data-node-id="big"]')).toHaveCount(0);

    await page.reload();
    await expect(text(page, "alpha")).toBeVisible();
    await expect(page.locator('li[data-node-id="big"]')).toHaveCount(0);
  });

  test("a small undo stays synchronous — no progress dialog (regression)", async ({
    page,
  }) => {
    await seedOutline(page, STANDARD_TREE);
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();

    // A small structural change (3-node subtree delete), then undo it.
    await text(page, "alpha").click();
    await page.keyboard.press("ControlOrMeta+Shift+Backspace");
    await expect(page.locator('li[data-node-id="alpha"]')).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(text(page, "alpha")).toBeVisible();

    // The sliced-path dialog never mounted (a 3-op diff is < 500).
    await expect(page.getByTestId("history-restore-dialog")).toHaveCount(0);
    // And the restore persisted.
    await page.reload();
    await expect(text(page, "alpha")).toBeVisible();
  });
});
