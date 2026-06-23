import { expect, test, type Page } from "@playwright/test";
import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// A node's OWN editable text span -- same locator the nav spec uses. Child
// bullets live in a nested <ul>, so the `>` chain can't reach them.
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .node-text`);

// The bullet that currently holds the caret. After an Enter-split the new
// sibling is focused, but its id is freshly generated, so we find it by focus.
const focused = (page: Page) => page.locator(".node-text:focus");

// Every visible bullet's raw text in document order (NOT normalized, so an
// empty new bullet shows up as ""). Used to assert sibling vs child placement
// when the new node's id is unknown.
const orderedTexts = (page: Page) =>
  page.locator(".outline-row > .node-text").allTextContents();

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

// Focus `id` and drop the caret at absolute character offset `col`. We set the
// Selection range directly rather than press Home/Arrow keys: on macOS Chromium
// those don't reliably move the caret inside a contentEditable, and a plain
// click lands past the text. This mirrors the app's own setCaretOffset walk.
async function caretAt(page: Page, id: string, col: number) {
  await text(page, id).click();
  await text(page, id).evaluate((el, target) => {
    const sel = window.getSelection();
    if (!sel) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    const range = document.createRange();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
      node = walker.nextNode();
    }
    // Empty bullet or past the end: land at the very end.
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }, col);
}

test.describe("Enter splits the bullet at the caret", () => {
  test("caret mid-text: text right of the caret moves to a new sibling below", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
    ]);

    await caretAt(page, "n", 5); // between "alpha" and "bravo"
    await page.keyboard.press("Enter");

    // Left of the caret stays on the original node.
    await expect(text(page, "n")).toHaveText("alpha");
    // Right of the caret seeds the new sibling, which is now focused.
    await expect(focused(page)).toHaveText("bravo");
    // ...and the caret sits at the START of it: typing lands at the front.
    await page.keyboard.type("X");
    await expect(focused(page)).toHaveText("Xbravo");
    // It's a sibling (same depth), not a child: order is original then new.
    expect(await orderedTexts(page)).toEqual(["alpha", "Xbravo"]);
  });

  test("caret at the end: new empty sibling, like a plain new line", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alpha" },
    ]);

    await caretAt(page, "n", 5); // end of "alpha"
    await page.keyboard.press("Enter");

    await expect(text(page, "n")).toHaveText("alpha");
    await expect(focused(page)).toHaveText("");
    // The new empty bullet is focused and ready to type into.
    await page.keyboard.type("beta");
    await expect(focused(page)).toHaveText("beta");
    expect(await orderedTexts(page)).toEqual(["alpha", "beta"]);
  });

  test("caret at the start: pushes all text down, leaves an empty bullet above", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alpha" },
    ]);

    await caretAt(page, "n", 0);
    await page.keyboard.press("Enter");

    // The original node is left empty; all its text moved into the new bullet.
    await expect(text(page, "n")).toHaveText("");
    await expect(focused(page)).toHaveText("alpha");
    expect(await orderedTexts(page)).toEqual(["", "alpha"]);
  });

  test("caret at end of an EXPANDED parent still dives in (child at top), no split", async ({
    page,
  }) => {
    // STANDARD_TREE: alpha is expanded with children alpha-1, alpha-2. Enter at
    // the end of an open parent adds a child at the TOP of its list -- the
    // dive-in case, preserved by the split (after-text is empty there).
    await load(page, STANDARD_TREE);

    await caretAt(page, "alpha", 5); // end of "Alpha"
    await page.keyboard.press("Enter");

    await expect(text(page, "alpha")).toHaveText("Alpha");
    await expect(focused(page)).toHaveText("");
    // The empty new bullet sits BETWEEN alpha and alpha-1 -> it's alpha's first
    // child, not a sibling.
    expect(await orderedTexts(page)).toEqual([
      "Alpha",
      "",
      "Alpha one",
      "Alpha two",
      "Bravo",
      "Charlie",
    ]);
  });

  test("split is a single undo step that restores the original bullet", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
    ]);

    await caretAt(page, "n", 5);
    await page.keyboard.press("Enter");
    await expect(focused(page)).toHaveText("bravo");

    await page.keyboard.press(`${modifier()}+z`);

    // One undo collapses the split back to the original single bullet.
    await expect(text(page, "n")).toHaveText("alphabravo");
    expect(await orderedTexts(page)).toEqual(["alphabravo"]);
  });
});

// Cmd on macOS, Control elsewhere -- the e2e run is chromium on whatever host.
function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}
