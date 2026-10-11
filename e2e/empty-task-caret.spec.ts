// Regression: an empty task's caret must sit AFTER the checkbox, not before it.
// The checkbox floats left inside the block `.row-body`; an empty editable's
// caret is drawn at its own content origin (x=0), which lands before the float.
// The `.node-text:empty { display: flow-root }` rule places the empty span's box
// beside the float so the caret renders after the checkbox (see styles.css).
import { expect, test } from "@playwright/test";

import { placeCaret, seedOutline, text, type SeedNode } from "./fixtures";

const TREE: SeedNode[] = [
  { id: "t1", parentId: null, prevSiblingId: null, text: "", isTask: true },
];

test("empty task caret sits to the right of the checkbox", async ({ page }) => {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(text(page, "t1")).toBeVisible();

  // Focus the empty task and place the caret in it.
  await text(page, "t1").click();
  await placeCaret(text(page, "t1"), "end");

  // The caret for an empty editable is drawn at the element's content-box
  // origin, so the .node-text left edge is where the caret renders. It must be
  // to the RIGHT of the checkbox, not before it.
  await expect(async () => {
    const { textLeft, checkboxRight } = await page.evaluate(() => {
      const row = document.querySelector('li[data-node-id="t1"] .outline-row')!;
      const checkbox = row.querySelector(".checkbox")!;
      const nodeText = row.querySelector(".node-text")!;
      return {
        textLeft: nodeText.getBoundingClientRect().left,
        checkboxRight: checkbox.getBoundingClientRect().right,
      };
    });

    expect(textLeft).toBeGreaterThanOrEqual(checkboxRight);
  }).toPass({ timeout: 5000 });
});
