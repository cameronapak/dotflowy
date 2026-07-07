// A structural batch over 500 ops is committed with a CHUNKED changelog
// (worker/outline-do.ts recordChange -> planChangeFrames, issue #124), so the
// DO echoes MULTIPLE change frames ending at the final seq the POST returned.
// The one client-side assumption: the optimistic overlay (runStructural ->
// waitForSeq(finalSeq)) holds across that whole multi-frame echo, with synced
// state updating beneath, and releases only at the final frame. This spec
// reproduces the shape with the fixture's echoChunks option and asserts no
// partial revert at any point.
import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

const FLAT: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
  { id: "b", parentId: null, prevSiblingId: "a", text: "bravo" },
  { id: "c", parentId: null, prevSiblingId: "b", text: "charlie" },
  { id: "d", parentId: null, prevSiblingId: "c", text: "delta" },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const indented = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"][data-parent-id="a"]`);

test("optimistic overlay holds across a multi-frame batch echo", async ({
  page,
}) => {
  // One batch -> 3 frames at ~250 / ~500 / ~750 ms; POST replies with the
  // FINAL seq immediately (mirrors applyBatch returning after commit).
  await seedOutline(page, FLAT, { echoDelayMs: 250, echoChunks: 3 });
  await page.goto("/");
  await expect(text(page, "a")).toBeVisible();

  // Select the [b, c, d] run and indent it under `a` -- >=3 ops in ONE batch.
  await text(page, "d").click();
  await expect(text(page, "d")).toBeFocused();
  await page.keyboard.press("Shift+ArrowUp"); // enter -> [d]
  await page.keyboard.press("Shift+ArrowUp"); // extend -> [c, d]
  await page.keyboard.press("Shift+ArrowUp"); // extend -> [b, c, d]
  await page.keyboard.press("Tab");

  // t~0 (no frame yet): the optimistic overlay shows the full indent.
  for (const id of ["b", "c", "d"]) await expect(indented(page, id)).toBeVisible();

  // Mid-echo (~frame 1 applied, frames 2-3 pending): the overlay must hold the
  // COMPLETE post-batch shape -- no partial revert while synced state updates
  // beneath it.
  await page.waitForTimeout(400);
  for (const id of ["b", "c", "d"]) await expect(indented(page, id)).toBeVisible();
  await expect(page.locator("li[data-node-id]:not([data-parent-id])")).toHaveCount(1);

  // Past the final frame: overlay released onto identical synced state.
  await page.waitForTimeout(600);
  for (const id of ["b", "c", "d"]) await expect(indented(page, id)).toBeVisible();
  await expect(page.locator("li[data-node-id]:not([data-parent-id])")).toHaveCount(1);

  // Hard proof the SYNCED layer (not a lingering overlay) holds the final
  // shape: reload -- the snapshot GET returns the mock store.
  await page.reload();
  await expect(text(page, "a")).toBeVisible();
  for (const id of ["b", "c", "d"]) await expect(indented(page, id)).toBeVisible();
});
