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
  await expect(page.locator('li[data-node-id="a0"] .node-text')).toBeFocused();
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

test("same-spot mouse drops preserve order and the redo timeline", async ({
  page,
}) => {
  await load(page);
  const text = page.locator('li[data-node-id="a2"] .node-text');
  await text.fill("edited");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(text).toHaveText("node2");
  // Undo restores a text selection. Collapse it before testing the dot so
  // the appearing selection toolbar cannot intercept the pointerdown.
  await text.press("ArrowRight");
  await expect(
    page.getByRole("toolbar", { name: "Format selection" }),
  ).toBeHidden();

  const bullet = page.locator('li[data-node-id="a2"] .bullet');
  const box = await bullet.boundingBox();
  if (!box) throw new Error("no bullet box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  for (const returnToStart of [false, true]) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + (returnToStart ? 70 : 6));
    await expect(page.locator(".drag-pill")).toBeVisible();
    if (returnToStart) await page.mouse.move(x, y);
    await page.mouse.up();
    await expect
      .poll(() => visibleOrder(page))
      .toEqual(flatList().map((n) => n.id));
  }
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await page.getByRole("option", { name: /^Redo typing/ }).click();
  await expect(text).toHaveText("edited");
});

test.describe("touch drag", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("a dot swipe scrolls without reordering, and the next dot tap zooms", async ({
    page,
  }) => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      parentId: null,
      prevSiblingId: i ? `t${i - 1}` : null,
      text: `Touch ${i + 1}`,
    }));
    await seedOutline(page, nodes);
    await openSeededOutline(page, { anchorId: "t0" });
    const bullet = page.locator('li[data-node-id="t8"] .bullet');
    const box = await bullet.boundingBox();
    if (!box) throw new Error("no bullet box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const before = await page.evaluate(() => scrollY);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 6; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - step * 20 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => page.evaluate(() => scrollY))
      .toBeGreaterThan(before + 40);
    await expect(page.locator(".drag-pill")).toHaveCount(0);
    const saved = await page.evaluate(async () =>
      (await fetch("/api/nodes")).json(),
    );
    expect(
      saved.map((n: SeedNode) => [n.id, n.parentId, n.prevSiblingId]).sort(),
    ).toEqual(nodes.map((n) => [n.id, n.parentId, n.prevSiblingId]).sort());
    await expect(page.locator(".node-text:focus")).toHaveCount(0);
    await bullet.tap();
    await expect(page).toHaveURL(/\/t8$/);
  });

  test("a held touch reorders at the indicated gap without entering the editor", async ({
    page,
  }) => {
    await load(page);
    const box = await page
      .locator('li[data-node-id="a2"] .bullet')
      .boundingBox();
    if (!box) throw new Error("no bullet box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const target = await rowBox(page, "a6");
    const cdp = await page.context().newCDPSession(page);
    // A pickup close to its starting point is a no-op; cancellation after
    // leaving that gap also must not commit or leave gesture UI behind.
    for (const ending of ["same-spot", "cancel", "second-finger"]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: ending === "same-spot" ? y + 6 : target.y }],
      });
      await expect(page.locator(".drag-pill")).toBeVisible();
      if (ending === "second-finger") {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [
            { x, y: target.y },
            { x: x + 80, y: target.y },
          ],
        });
        await expect(page.locator(".drag-pill, .drag-indicator")).toHaveCount(
          0,
        );
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: ending === "cancel" ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
      await expect(page.locator(".drag-pill, .drag-indicator")).toHaveCount(0);
      await expect
        .poll(() => visibleOrder(page))
        .toEqual(flatList().map((n) => n.id));
      await expect(page.locator(".node-text:focus")).toHaveCount(0);
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    // Gesture duration, not a rendering wait: hold before moving the finger.
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (let step = 1; step <= 6; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + ((target.y - y) * step) / 6 }],
      });
    }
    await expect(page.locator(".drag-indicator")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => visibleOrder(page))
      .toEqual(["a0", "a1", "a3", "a4", "a5", "a2", "a6", "a7"]);
    await expect(page.locator(".node-text:focus")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);

    // A mouse on this same coarse-pointer device still drags immediately and
    // focuses the landing row. Device-wide touch detection would get this wrong.
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const mouseStart = await page
      .locator('li[data-node-id="a2"] .bullet')
      .boundingBox();
    if (!mouseStart) throw new Error("no bullet box");
    const mouseTarget = await rowBox(page, "a1");
    const mx = mouseStart.x + mouseStart.width / 2;
    await page.mouse.move(mx, mouseStart.y + mouseStart.height / 2);
    await page.mouse.down();
    await page.mouse.move(mx, mouseTarget.y, { steps: 5 });
    await expect(page.locator(".drag-pill")).toBeVisible();
    await page.mouse.up();
    await expect
      .poll(() => visibleOrder(page))
      .toEqual(["a0", "a2", "a1", "a3", "a4", "a5", "a6", "a7"]);
    await expect(
      page.locator('li[data-node-id="a2"] .node-text'),
    ).toBeFocused();
  });
});
