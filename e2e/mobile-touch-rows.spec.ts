import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  seedOutline,
  STANDARD_TREE,
  text,
} from "./fixtures";

// Coarse-pointer tap-to-edit (ADR 0029) uses mobile emulation, not a
// synthetic class, so the same pointer media query as on touch devices runs.
test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 412, height: 900 },
});

async function load(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await openSeededOutline(page, { anchorId: "alpha" });
}

test("tapping a row's dead space focuses the text and drops a caret", async ({
  page,
}) => {
  await load(page);
  // bravo is childless (no chevron) and short ("Bravo"): the band to the right
  // of the text is row-body dead space. Tap it well left of the reserved right
  // padding so the tap lands on the .row-body block itself (target ===
  // currentTarget), never on the text span.
  const body = page.locator(
    `li[data-node-id="bravo"] > .outline-row .row-body`,
  );
  const box = await body.boundingBox();
  expect(box).not.toBeNull();
  await body.click({ position: { x: box!.width - 60, y: box!.height / 2 } });

  // The bullet's own text span now holds the caret.
  await expect(text(page, "bravo")).toBeFocused();
  // A collapsed caret sits inside that span (tap-to-edit placed it).
  await expect
    .poll(() =>
      text(page, "bravo").evaluate((el) => {
        const sel = window.getSelection();
        return (
          !!sel &&
          sel.rangeCount > 0 &&
          sel.isCollapsed &&
          el.contains(sel.anchorNode)
        );
      }),
    )
    .toBe(true);
});
