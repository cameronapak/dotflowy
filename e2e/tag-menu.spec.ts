import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// The `#` autocomplete is now a plugin menu (ADR 0018 Seam H): the tags plugin
// registers a MenuSpec, and the generic core engine (menu-engine.tsx) detects
// the trigger, portals the list, and splices the pick. This spec locks in that
// plugin-routed behavior end to end -- nothing else covers the menu engine.

const TAGGED_TREE: SeedNode[] = [
  // Carries an existing tag, so it's in the autocomplete corpus.
  { id: "a", parentId: null, prevSiblingId: null, text: "Ship it #urgent" },
  // The empty bullet we type into.
  { id: "b", parentId: null, prevSiblingId: "a", text: "" },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page) {
  await seedOutline(page, TAGGED_TREE);
  await page.goto("/");
  await expect(text(page, "a")).toBeVisible();
}

test.describe("tag autocomplete (plugin Seam H)", () => {
  test("typing #<query> lists matching existing tags; picking one completes it", async ({
    page,
  }) => {
    await load(page);

    await text(page, "b").click();
    await page.keyboard.type("#urg");

    // The engine opened the tags plugin's menu, listing the existing tag as its
    // colored chip.
    const option = page.locator(
      '[role="listbox"] .tag-option[data-tag="urgent"]',
    );
    await expect(option).toBeVisible();

    // Click the option (mousedown keeps the bullet focused, then the engine
    // splices the full tag over the "#urg" the user typed).
    await option.click();
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);

    // The bullet now carries the completed tag, rendered as its inline chip.
    await expect(
      text(page, "b").locator('.tag[data-tag="urgent"]'),
    ).toBeVisible();
  });

  test("adding a second tag to a node that already has one still lists it", async ({
    page,
  }) => {
    // Regression: the corpus used to exclude the whole node being edited, so a
    // node's OWN existing tags never autocompleted when you added another tag
    // to that same node. Here "#urgent" lives only on node "a"; typing a second
    // tag into "a" must still surface it.
    await seedOutline(page, [
      { id: "a", parentId: null, prevSiblingId: null, text: "#urgent" },
    ]);
    await page.goto("/");
    await expect(text(page, "a")).toBeVisible();

    // Focus + caret at the very end via evaluate -- a plain click would land on
    // the "#urgent" chip and fire its filter interaction (Seam B), not the caret.
    await text(page, "a").evaluate((el) => {
      (el as HTMLElement).focus();
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type(" #urg");

    await expect(
      page.locator('[role="listbox"] .tag-option[data-tag="urgent"]'),
    ).toBeVisible();
  });

  test("a query with no existing match does not open the menu", async ({
    page,
  }) => {
    await load(page);

    await text(page, "b").click();
    // No existing tag contains "xyz", so the menu stays closed -- finishing a
    // brand-new tag must never be swallowed (openWhenEmpty is off).
    await page.keyboard.type("#xyz");

    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
  });

  test("opens on the zoomed page title too (the second render path)", async ({
    page,
  }) => {
    await load(page);
    await page.goto("/b"); // zoom into the empty node -- it's now the title

    const title = page.locator(".zoomed-title .node-text");
    await expect(title).toBeVisible();
    await title.click();
    await page.keyboard.type("#urg");

    await expect(
      page.locator('[role="listbox"] .tag-option[data-tag="urgent"]'),
    ).toBeVisible();

    await page
      .locator('[role="listbox"] .tag-option[data-tag="urgent"]')
      .click();
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    await expect(title.locator('.tag[data-tag="urgent"]')).toBeVisible();
  });
});
