import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Drag-reorder while a ?q= filter is active (issue #244 / the ADR 0047
// amendment). Before the fix, buildRows passed `filter: null`, so the drag's
// row model diverged from the rendered rows: filtered-out rows polluted the
// model with missing geometry and rows revealed inside collapsed subtrees were
// missing entirely. Now the drag threads the active filter, so its rows ARE the
// filtered rows on screen. Two behaviors pinned here:
//   (a) a drop in a gap whose real tree has hidden siblings between the two
//       visible rows lands immediately AFTER the visible predecessor;
//   (b) a drop that lands the node outside the filter's visible set discloses
//       with a quiet toast and the node vanishes from the filtered view (but is
//       still there once the filter clears).
//
// The pointer simulation mirrors drag-reorder.spec.ts. Nesting/order is asserted
// via data-parent-id / the virtualizer's data-index order, never DOM
// containment (rows are windowed, ADR 0019).

const rowBox = async (page: Page, id: string) => {
  const box = await page.locator(`li[data-node-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`row ${id} has no box`);
  return box;
};

// Let the window virtualizer flush its row measurements. The drag projects drop
// gaps from the virtualizer's measurements (virtualRowRect), not the DOM, and a
// still-estimated (unmeasured) row rect shifts the projection by a row -- so
// settle a couple frames before reading boxes and dragging (ADR 0019).
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );

// The rendered order of mounted rows, by the virtualizer's flat index.
const visibleOrder = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("li[data-node-id]"))
      .map((li) => ({
        id: (li as HTMLElement).dataset.nodeId!,
        index: Number((li as HTMLElement).dataset.index),
      }))
      .sort((x, y) => x.index - y.index)
      .map((r) => r.id),
  );

async function load(page: Page, tree: SeedNode[], query: string) {
  await seedOutline(page, tree);
  await page.goto(`/?q=${encodeURIComponent(query)}`);
}

test.describe("drag reorder under an active ?q= filter (#244)", () => {
  test("a drop between two visible rows with hidden siblings lands after the visible predecessor", async ({
    page,
  }) => {
    // Real top-level order: S1, S2, V1, H1, H2, V2, X. Under #go the untagged
    // H1/H2 are pruned, leaving S1, S2, V1, V2, X. The S1/S2 spacers keep the
    // target V1/V2 gap well below the top-edge auto-scroll band so the drop
    // resolves to that gap, not the top.
    const tree: SeedNode[] = [
      { id: "S1", parentId: null, prevSiblingId: null, text: "spacer1 #go" },
      { id: "S2", parentId: null, prevSiblingId: "S1", text: "spacer2 #go" },
      { id: "V1", parentId: null, prevSiblingId: "S2", text: "visible1 #go" },
      { id: "H1", parentId: null, prevSiblingId: "V1", text: "hidden1" },
      { id: "H2", parentId: null, prevSiblingId: "H1", text: "hidden2" },
      { id: "V2", parentId: null, prevSiblingId: "H2", text: "visible2 #go" },
      { id: "X", parentId: null, prevSiblingId: "V2", text: "mover #go" },
    ];
    await load(page, tree, "#go");
    await expect(page.locator('li[data-node-id="V1"]')).toBeVisible();
    // Sanity: the hidden siblings are pruned out of the DOM.
    await expect(page.locator('li[data-node-id="H1"]')).toHaveCount(0);
    await expect(page.locator('li[data-node-id="H2"]')).toHaveCount(0);
    await settle(page);

    const bullet = page.locator('li[data-node-id="X"] .bullet');
    const from = await bullet.boundingBox();
    if (!from) throw new Error("no bullet box");
    const startX = from.x + from.width / 2;
    const startY = from.y + from.height / 2;

    // Drop in the gap between the two VISIBLE rows V1 and V2, at depth 0 (x
    // aligned with the top-level bullets). Aim a quarter-row into V2 (not its
    // exact top boundary) so a sub-pixel measurement wobble can't flip the gap
    // one row up. Per the drop-slot rule this lands X immediately after the
    // visible predecessor V1 -- the hidden siblings H1/H2 end up after X.
    const v2 = await rowBox(page, "V2");
    const dropY = v2.y + Math.min(8, v2.height / 4);
    // The structural batch POSTs to the /api/nodes mock; await it so the store
    // has the move before we navigate away (goto would abort an in-flight POST,
    // and the reconnect snapshot would replay the pre-move tree).
    const committed = page.waitForResponse(
      (r) => r.url().includes("/api/nodes") && r.request().method() === "POST",
    );
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 10, startY + 10, { steps: 3 });
    await page.mouse.move(startX, dropY, { steps: 5 });
    await page.mouse.up();

    // Filtered view now reads S1, S2, V1, X, V2 (X landed right after V1).
    await expect
      .poll(() => visibleOrder(page))
      .toEqual(["S1", "S2", "V1", "X", "V2"]);

    // Clear the filter and confirm the REAL sibling order: X sits between V1 and
    // the hidden siblings -- immediately after the visible predecessor.
    await committed;
    await page.goto("/");
    await expect(page.locator('li[data-node-id="V1"]')).toBeVisible();
    await expect
      .poll(() => visibleOrder(page))
      .toEqual(["S1", "S2", "V1", "X", "H1", "H2", "V2"]);
  });

  test("a drop that lands the node hidden discloses with a toast and the node vanishes from the filtered view", async ({
    page,
  }) => {
    // Rendered under #go: A (match), C (A's child -- revealed match-descendant,
    // undimmed, NOT a match), P (dimmed context ancestor of K), K (match).
    const tree: SeedNode[] = [
      { id: "A", parentId: null, prevSiblingId: null, text: "alpha #go" },
      { id: "C", parentId: "A", prevSiblingId: null, text: "child plain" },
      { id: "P", parentId: null, prevSiblingId: "A", text: "papa plain" },
      { id: "K", parentId: "P", prevSiblingId: null, text: "kilo #go" },
    ];
    await load(page, tree, "#go");
    await expect(page.locator('li[data-node-id="C"]')).toBeVisible();
    await expect(page.locator('li[data-node-id="K"]')).toBeVisible();
    await settle(page);

    const bullet = page.locator('li[data-node-id="C"] .bullet');
    const from = await bullet.boundingBox();
    if (!from) throw new Error("no bullet box");
    const startX = from.x + from.width / 2;
    const startY = from.y + from.height / 2;

    // Drop C into the gap at the top of K (between P and K). There, both the
    // shallowest and deepest legal depth are K's depth, so C becomes a child of
    // the dimmed context ancestor P. C is not a match, has no tagged descendant,
    // and P is not a match -> C is no longer in the filter's visible set.
    // Aim a quarter-row into K (not its exact top boundary) so a sub-pixel
    // measurement wobble can't flip the gap up and open the depth clamp (test 1's
    // anti-wobble technique). At this gap both min and max legal depth are K's,
    // so C becomes a child of the dimmed ancestor P; the +40 rightward nudge is
    // harmless once the gap is pinned.
    const k = await rowBox(page, "K");
    const dropY = k.y + Math.min(8, k.height / 4);
    // Await the structural batch POST so the mock store has the move before we
    // navigate away (see test 1).
    const committed = page.waitForResponse(
      (r) => r.url().includes("/api/nodes") && r.request().method() === "POST",
    );
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 10, startY + 10, { steps: 3 });
    await page.mouse.move(startX + 40, dropY, { steps: 5 });
    await page.mouse.up();

    // The disclosure toast fires (the move isn't silent).
    await expect(page.getByText("hidden by the current filter")).toBeVisible();

    // C is gone from the filtered view...
    await expect(page.locator('li[data-node-id="C"]')).toHaveCount(0);

    // ...but present once the filter clears, now a child of P.
    await committed;
    await page.goto("/");
    const c = page.locator('li[data-node-id="C"]');
    await expect(c).toBeVisible();
    await expect(c).toHaveAttribute("data-parent-id", "P");
  });
});
