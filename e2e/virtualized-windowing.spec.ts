import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Phase B (ADR 0019): the windowed render mounts only ~viewport rows, regardless
// of how many nodes exist. These specs force the flag ON (so they're meaningful
// even if the compiled default ever flips) and prove the DOM row count stays
// bounded as the outline grows to thousands of nodes -- the whole point of the
// virtualization, which the parity suite (behavioral) doesn't directly assert.

// 40 parents x 50 children = 2040 nodes, all expanded -- two depths so the
// screenshot shows real indentation, and far more rows than any viewport holds.
function bigTree(): SeedNode[] {
  const nodes: SeedNode[] = [];
  let prevTop: string | null = null;
  for (let p = 0; p < 40; p++) {
    const pid = `p${p}`;
    nodes.push({ id: pid, parentId: null, prevSiblingId: prevTop, text: `Parent ${p}` });
    prevTop = pid;
    let prevChild: string | null = null;
    for (let c = 0; c < 50; c++) {
      const cid = `p${p}c${c}`;
      nodes.push({ id: cid, parentId: pid, prevSiblingId: prevChild, text: `Item ${p}.${c}` });
      prevChild = cid;
    }
  }
  return nodes;
}

const rowCount = (page: Page) => page.locator("li[data-node-id]").count();

async function loadBig(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("dotflowy:flag:virtualized", "on"),
  );
  await seedOutline(page, bigTree());
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="p0"] > .outline-row .node-text'),
  ).toBeVisible();
}

test.describe("virtualized windowing (ADR 0019)", () => {
  test("renders only ~viewport rows out of thousands", async ({ page }) => {
    await loadBig(page);

    // 2040 nodes exist, but only a viewport's worth (+ overscan) are mounted.
    // Generous ceiling: a tall viewport at ~32px/row is well under 100 rows.
    const mounted = await rowCount(page);
    expect(mounted).toBeGreaterThan(5);
    expect(mounted).toBeLessThan(100);

    // A node deep in the list is NOT mounted yet (it's below the window).
    await expect(page.locator('li[data-node-id="p39c49"]')).toHaveCount(0);
  });

  test("the window follows the scroll: late rows mount, early rows unmount", async ({
    page,
  }) => {
    await loadBig(page);
    await expect(page.locator('li[data-node-id="p0"]')).toBeVisible();

    // Scroll deep into the list and wait for the window to SETTLE there: a row
    // far down the flat order is mounted AND the top row (p0) is gone, read in
    // one atomic snapshot (dynamic measurement briefly nudges scroll as rows
    // settle, so two separate reads could race). This is the "the window follows
    // the scroll" property -- asserting a deep index rather than the literal last
    // leaf, which estimate-based sizing makes finicky to hit by scrolling.
    await page.evaluate(() => window.scrollTo(0, 20000));
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const lis = Array.from(
              document.querySelectorAll("li[data-node-id]"),
            ) as HTMLElement[];
            const maxIdx = Math.max(
              0,
              ...lis.map((l) => Number(l.dataset.index) || 0),
            );
            const hasTop = lis.some((l) => l.dataset.nodeId === "p0");
            return maxIdx > 300 && !hasTop && lis.length < 100;
          }),
        { timeout: 8000 },
      )
      .toBe(true);

    // Scroll back to the top: the first node mounts again.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('li[data-node-id="p0"]')).toBeVisible();
  });

  test("a deep node still indents by depth", async ({ page }) => {
    await loadBig(page);
    // Children render one level in (data-depth = 1); parents at depth 0.
    await expect(page.locator('li[data-node-id="p0"]')).toHaveAttribute(
      "data-depth",
      "0",
    );
    await expect(page.locator('li[data-node-id="p0c0"]')).toHaveAttribute(
      "data-depth",
      "1",
    );
  });
});
