import { expect, test, type Page } from "@playwright/test";

import { openSeededOutline, seedOutline, type SeedNode } from "./fixtures";

// Pointer drag-to-reorder on the windowed path (ADR 0019 + ADR 0010). The drop
// hit-test synthesizes row rects from the virtualizer's measurements
// (virtualRowRect), whose `start` values are already DOCUMENT-space -- adding
// scrollMargin on top shifted every rect (and the indicator) down by the
// header height, so the drop line landed rows below the pointer. These specs
// pin the indicator to the hovered gap in real viewport coordinates and prove
// the drop commits at that gap.

function flatList(): SeedNode[] {
  const nodes: SeedNode[] = [];
  let prev: string | null = null;
  for (let i = 0; i < 8; i++) {
    const id = `a${i}`;
    nodes.push({ id, parentId: null, prevSiblingId: prev, text: `node${i}` });
    prev = id;
  }
  return nodes;
}

async function load(page: Page) {
  await seedOutline(page, flatList());
  await openSeededOutline(page, { anchorId: "a0" });
}

const rowBox = async (page: Page, id: string) => {
  const box = await page.locator(`li[data-node-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`row ${id} has no box`);
  return box;
};

// The rendered order of mounted rows, by the virtualizer's flat index.
const visibleOrder = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLLIElement>("li[data-node-id]"))
      .map((li) => ({
        id: li.dataset.nodeId!,
        index: Number(li.dataset.index),
      }))
      .sort((x, y) => x.index - y.index)
      .map((r) => r.id),
  );

test("after cold loading, the drop indicator and saved order match the hovered gap", async ({
  page,
}) => {
  const controller = await seedOutline(page, flatList());
  const release = controller.holdSnapshots();
  await page.goto("/");
  await page
    .getByRole("status", { name: "Loading outline" })
    .waitFor({ state: "visible" });
  // Let the loading layout and its initial ResizeObserver delivery finish
  // before mounting the list. No resize or navigation may repair the geometry.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  release();
  await expect(page.locator('li[data-node-id="a0"]')).toBeVisible();

  const bullet = page.locator('li[data-node-id="a0"] .bullet');
  const from = await bullet.boundingBox();
  if (!from) throw new Error("no bullet box");
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;

  // The gap between a3 and a4, in true viewport coordinates.
  const a4 = await rowBox(page, "a4");
  const gapY = a4.y;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Cross the 5px threshold to arm the drag, then hover the a3/a4 gap.
  await page.mouse.move(startX + 10, startY + 10, { steps: 3 });
  await page.mouse.move(startX, gapY, { steps: 5 });

  const indicator = page.locator(".drag-indicator");
  await expect(indicator).toBeVisible();
  const line = await indicator.boundingBox();
  if (!line) throw new Error("no indicator box");
  // Before the scrollMargin fix this was off by the header height (~100px+);
  // allow half a row of slack for midpoint rounding.
  expect(Math.abs(line.y - gapY)).toBeLessThan(16);

  await page.mouse.up();

  // The drop committed at the hovered gap: a0 now sits between a3 and a4.
  await expect
    .poll(() => visibleOrder(page))
    .toEqual(["a1", "a2", "a3", "a0", "a4", "a5", "a6", "a7"]);
  await expect
    .poll(async () => {
      const nodes = await page.evaluate(async () =>
        (await fetch("/api/nodes")).json(),
      );
      return nodes.find((node: SeedNode) => node.id === "a0")?.prevSiblingId;
    })
    .toBe("a3");
});

test("dragging right of a row nests the drop one level deeper", async ({
  page,
}) => {
  await load(page);

  const bullet = page.locator('li[data-node-id="a5"] .bullet');
  const from = await bullet.boundingBox();
  if (!from) throw new Error("no bullet box");
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;

  // Hover the gap under a2, well right of its bullet: depth 1 = a2's child.
  const a3 = await rowBox(page, "a3");
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY + 10, { steps: 3 });
  await page.mouse.move(startX + 80, a3.y, { steps: 5 });
  await page.mouse.up();

  const li = page.locator('li[data-node-id="a5"]');
  await expect(li).toHaveAttribute("data-parent-id", "a2");
  await expect(li).toHaveAttribute("data-depth", "1");
});
