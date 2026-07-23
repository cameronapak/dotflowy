// Big-subtree delete confirmation + sliced progress: any delete funnel whose
// subtree count reaches DELETE_CONFIRM_THRESHOLD (30) opens a confirm dialog
// ("Delete N bullets?") instead of deleting inline; confirming runs the
// deletion as ONE runStructuralSliced batch (repoints + reverse-pre-order
// deletes in yielding slices) with modal progress. Small deletes are
// unchanged. One Cmd+Z restores the whole subtree either way.
import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  seedOutline,
  STANDARD_TREE,
  waitForSeededNode,
  type SeedNode,
} from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

/** STANDARD_TREE plus a "big" top-level parent with `n` children — enough to
 *  cross the confirm threshold (30) or the slice size (500). */
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

test.describe("big-delete confirmation", () => {
  test("a small delete never asks (regression)", async ({ page }) => {
    await seedOutline(page, STANDARD_TREE);
    await openSeededOutline(page, { anchorId: "alpha" });
    await expect(text(page, "alpha")).toBeVisible();

    // alpha's subtree is 3 nodes (< 30): deleted inline, no dialog.
    await text(page, "alpha").click();
    await page.keyboard.press("ControlOrMeta+Shift+Backspace");
    await expect(page.locator('li[data-node-id="alpha"]')).toHaveCount(0);
    await expect(page.getByTestId("delete-confirm-dialog")).toHaveCount(0);
  });

  test("a threshold-plus subtree asks first; cancel keeps everything", async ({
    page,
  }) => {
    await seedOutline(page, bigSeed(40)); // 41-node subtree >= 30
    await openSeededOutline(page, { anchorId: "big" });
    await expect(text(page, "big")).toBeVisible();

    await text(page, "big").click();
    await page.keyboard.press("ControlOrMeta+Shift+Backspace");

    const summary = page.getByTestId("delete-confirm-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("41 bullets in total");
    await page.getByTestId("delete-cancel").click();

    // Nothing was deleted — and a reload agrees.
    await expect(text(page, "big")).toBeVisible();
    await page.reload();
    await waitForSeededNode(page, "big");
    await expect(text(page, "big")).toBeVisible();
  });

  test("confirming deletes the subtree, persists, and one Cmd+Z restores it", async ({
    page,
  }) => {
    await seedOutline(page, bigSeed(40));
    await openSeededOutline(page, { anchorId: "big" });
    await expect(text(page, "big")).toBeVisible();

    await text(page, "big").click();
    await page.keyboard.press("ControlOrMeta+Shift+Backspace");
    await page.getByTestId("delete-confirm").click();

    await expect(page.locator('li[data-node-id="big"]')).toHaveCount(0);
    // The sibling chain healed around the hole: charlie survives at top level.
    await expect(text(page, "charlie")).toBeVisible();
    // Persisted through the (mock) server store.
    await page.reload();
    await waitForSeededNode(page, "alpha");
    await expect(text(page, "alpha")).toBeVisible();
    await expect(page.locator('li[data-node-id="big"]')).toHaveCount(0);

    // (No reload-then-undo: the undo stack is session state. Re-run the flow
    // in-session to prove the single capture.)
    await seedOutline(page, bigSeed(40));
    await page.goto("/");
    await text(page, "big").click();
    await page.keyboard.press("ControlOrMeta+Shift+Backspace");
    await page.getByTestId("delete-confirm").click();
    await expect(page.locator('li[data-node-id="big"]')).toHaveCount(0);
    await text(page, "alpha").click();
    await expect(text(page, "alpha")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(text(page, "big")).toBeVisible();
  });

  test("a multi-slice delete (>500 nodes) shows progress and lands as ONE atomic batch", async ({
    page,
  }) => {
    // Delay the batch POST response so the dialog rests in its post-apply
    // "saving" phase — proof every slice applied while ONE batch is in flight.
    await seedOutline(page, bigSeed(600), { postDelayMs: 600 });
    await openSeededOutline(page, { anchorId: "big" });
    await expect(text(page, "big")).toBeVisible();

    await text(page, "big").click();
    await page.keyboard.press("ControlOrMeta+Shift+Backspace");
    await expect(page.getByTestId("delete-confirm-summary")).toContainText(
      "601 bullets in total",
    );
    await page.getByTestId("delete-confirm").click();

    await expect(page.getByTestId("delete-deleting")).toContainText(
      "Saving the deletion of 601 bullets as one atomic batch.",
    );
    // The dialog closes itself on success.
    await expect(page.getByTestId("delete-confirm-dialog")).toHaveCount(0);
    await expect(page.locator('li[data-node-id="big"]')).toHaveCount(0);
    await page.reload();
    await waitForSeededNode(page, "alpha");
    await expect(text(page, "alpha")).toBeVisible();
    await expect(page.locator('li[data-node-id="big"]')).toHaveCount(0);
  });

  test("the selection-mode Delete routes through the same confirm", async ({
    page,
  }) => {
    await seedOutline(page, bigSeed(40));
    await openSeededOutline(page, { anchorId: "big" });
    await expect(text(page, "big")).toBeVisible();

    // Enter node selection on the big parent (Shift+Down selects the focused
    // node), then Delete.
    await text(page, "big").click();
    await page.keyboard.press("Shift+ArrowDown");
    await expect(
      page.locator('li[data-node-id="big"][data-selected]'),
    ).toBeVisible();
    await page.keyboard.press("Backspace");

    await expect(page.getByTestId("delete-confirm-summary")).toContainText(
      "41 bullets in total",
    );
    await page.getByTestId("delete-confirm").click();
    await expect(page.locator('li[data-node-id="big"]')).toHaveCount(0);
    await expect(text(page, "charlie")).toBeVisible();
  });
});
