import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// A node's OWN editable text span -- same locator the nav spec uses. Child
// bullets live in a nested <ul>, so the `>` chain can't reach them.
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

// A node's row element. ADR 0019's flat windowed list has no DOM nesting, so
// parent/child is asserted via `data-parent-id` (absent = top level), never a
// containment selector.
const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

// Every rendered row in document order. Used to reach a freshly inserted node
// whose id we don't know.
const rows = (page: Page) => page.locator("li[data-node-id]");

// The bullet that currently holds the caret. After an Enter-split the new
// sibling is focused, but its id is freshly generated, so we find it by focus.
const focused = (page: Page) => page.locator(".node-text:focus");

// Every visible bullet's raw text in document order (NOT normalized, so an
// empty new bullet shows up as ""). Used to assert sibling vs child placement
// when the new node's id is unknown.
const orderedTexts = (page: Page) =>
  page.locator(".outline-row .node-text").allTextContents();

// The shaking element for a refused action -- NOT the same node as `row` above:
// `rowOf` resolves the span's enclosing `.outline-row`, and `rejectRow` puts the
// one-shot class there, one level inside the `li`.
const outlineRow = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);

async function load(
  page: Page,
  tree: SeedNode[],
  opts?: { hideCompleted?: boolean },
) {
  await seedOutline(page, tree);
  if (opts?.hideCompleted) {
    // Must be set before goto: the provider reads the persisted value on first
    // render, so flipping it afterwards wouldn't take until a reload.
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:show-completed", "false");
    });
  }
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

  test("caret at the start: inserts an empty bullet above, leaves this one alone", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alpha" },
    ]);

    await caretAt(page, "n", 0);
    await page.keyboard.press("Enter");

    // Enter at offset 0 is "make room above", not a split: `n` keeps its id AND
    // its text, and the new node is the empty one. The order below is identical
    // to the old (buggy) behavior -- only the IDENTITY flips, which is the bug.
    await expect(text(page, "n")).toHaveText("alpha");
    // Focus never left the text the user was editing.
    await expect(focused(page)).toHaveText("alpha");
    expect(await orderedTexts(page)).toEqual(["", "alpha"]);
  });

  test("caret at the start: the caret stays put, so typing continues the thought", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alpha" },
    ]);

    await caretAt(page, "n", 0);
    await page.keyboard.press("Enter");
    // Caret is still at the START of the ORIGINAL node -- a deliberate
    // divergence from Workflowy, which parks it in the new blank line.
    await page.keyboard.type("X");

    await expect(text(page, "n")).toHaveText("Xalpha");
    expect(await orderedTexts(page)).toEqual(["", "Xalpha"]);
  });

  test("caret at the start of a parent: children stay with the parent, not the blank line", async ({
    page,
  }) => {
    // The reported bug, verbatim: Enter at the start of P1 used to blank P1 and
    // hand its text to a new node below -- which left C1/C2 hanging off the
    // blank line instead of off P1.
    await load(page, [
      { id: "p1", parentId: null, prevSiblingId: null, text: "P1" },
      { id: "p2", parentId: null, prevSiblingId: "p1", text: "P2" },
      { id: "c1", parentId: "p1", prevSiblingId: null, text: "C1" },
      { id: "c2", parentId: "p1", prevSiblingId: "c1", text: "C2" },
    ]);

    await caretAt(page, "p1", 0);
    await page.keyboard.press("Enter");

    await expect(text(page, "p1")).toHaveText("P1");
    await expect(focused(page)).toHaveText("P1");
    expect(await orderedTexts(page)).toEqual(["", "P1", "C1", "C2", "P2"]);
    // The children still belong to P1...
    await expect(row(page, "c1")).toHaveAttribute("data-parent-id", "p1");
    await expect(row(page, "c2")).toHaveAttribute("data-parent-id", "p1");
    // ...and the new blank line is a top-level sibling above P1, childless.
    await expect(rows(page).first()).not.toHaveAttribute("data-parent-id", /./);
  });

  test("caret at the start of the FIRST child: the new bullet becomes the head of the list", async ({
    page,
  }) => {
    // The head-of-list case: `prevSiblingId` is null, so the insert has to
    // repoint the current head instead of skipping the follower lookup. A miss
    // leaves two nodes both claiming `prevSiblingId: null` -- a chain fan the
    // DEV tripwire in structural.ts logs (it only console.errors, so assert it
    // stayed silent).
    const chainErrors: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().includes("sibling-chain invariant broken")
      )
        chainErrors.push(msg.text());
    });

    await load(page, STANDARD_TREE);

    await caretAt(page, "alpha-1", 0);
    await page.keyboard.press("Enter");

    await expect(text(page, "alpha-1")).toHaveText("Alpha one");
    await expect(focused(page)).toHaveText("Alpha one");
    expect(await orderedTexts(page)).toEqual([
      "Alpha",
      "",
      "Alpha one",
      "Alpha two",
      "Bravo",
      "Charlie",
    ]);
    // The blank line is alpha's new first child, and the rest of the chain
    // (alpha-1 then alpha-2) survived intact.
    await expect(rows(page).nth(1)).toHaveAttribute("data-parent-id", "alpha");
    await expect(row(page, "alpha-2")).toHaveAttribute(
      "data-parent-id",
      "alpha",
    );
    expect(chainErrors).toEqual([]);
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

test.describe("Backspace joins the bullet into the one above", () => {
  test("Enter mid-text then Backspace returns the line to its pre-Enter state", async ({
    page,
  }) => {
    // The round trip no test drove before: BOTH presses go through the real
    // keyboard with no `evaluate` in between, so the caret state a second
    // keystroke actually finds is the one under test.
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
    ]);

    await caretAt(page, "n", 5); // between "alpha" and "bravo"
    await page.keyboard.press("Enter");
    await expect(focused(page)).toHaveText("bravo");

    await page.keyboard.press("Backspace");

    await expect(text(page, "n")).toHaveText("alphabravo");
    expect(await orderedTexts(page)).toEqual(["alphabravo"]);
    // The caret sits at the SEAM, not at either end: typing lands between the
    // two halves.
    await expect(text(page, "n")).toBeFocused();
    await page.keyboard.type("X");
    await expect(text(page, "n")).toHaveText("alphaXbravo");
  });

  test("a seeded bullet joins into its previous sibling, caret at the seam", async ({
    page,
  }) => {
    await load(page, [
      { id: "one", parentId: null, prevSiblingId: null, text: "alpha" },
      { id: "two", parentId: null, prevSiblingId: "one", text: "bravo" },
    ]);

    await caretAt(page, "two", 0);
    await page.keyboard.press("Backspace");

    await expect(text(page, "one")).toHaveText("alphabravo");
    await expect(page.locator('li[data-node-id="two"]')).toHaveCount(0);
    expect(await orderedTexts(page)).toEqual(["alphabravo"]);
    await page.keyboard.type("X");
    await expect(text(page, "one")).toHaveText("alphaXbravo");
  });

  test("the join is a single undo step that restores both the text and the node", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
    ]);

    await caretAt(page, "n", 5);
    await page.keyboard.press("Enter");
    await expect(focused(page)).toHaveText("bravo");
    await page.keyboard.press("Backspace");
    await expect(text(page, "n")).toHaveText("alphabravo");

    await page.keyboard.press(`${modifier()}+z`);

    // One undo puts back the split: the source node's text AND the row that was
    // merged away. (The Enter remains its own separate undo step.)
    await expect(text(page, "n")).toHaveText("alpha");
    expect(await orderedTexts(page)).toEqual(["alpha", "bravo"]);
  });

  test("a bullet with children refuses with a bare shake; its own first child still joins in", async ({
    page,
  }) => {
    // The children are on screen, so the reason is self-evident: shake, and
    // deliberately NO toast (the one place in the app where rejectRow travels
    // alone). Nothing is reparented.
    await load(page, [
      { id: "top", parentId: null, prevSiblingId: null, text: "alpha" },
      { id: "par", parentId: null, prevSiblingId: "top", text: "parent" },
      { id: "kid", parentId: "par", prevSiblingId: null, text: "kid" },
    ]);

    await caretAt(page, "par", 0);
    await page.keyboard.press("Backspace");
    await expect(outlineRow(page, "par")).toHaveClass(/node-rejected/);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await expect(text(page, "top")).toHaveText("alpha");
    expect(await orderedTexts(page)).toEqual(["alpha", "parent", "kid"]);

    // The class clears itself on animationend, so a repeat can re-trigger it.
    await expect(outlineRow(page, "par")).not.toHaveClass(/node-rejected/, {
      timeout: 4000,
    });

    // ...and the first child DOES merge into its parent (a different depth), so
    // the refusal above isn't just a dead keymap.
    await caretAt(page, "kid", 0);
    await page.keyboard.press("Backspace");
    await expect(text(page, "par")).toHaveText("parentkid");
    expect(await orderedTexts(page)).toEqual(["alpha", "parentkid"]);
  });

  test("a bullet hidden between the two rows refuses with a shake AND a toast", async ({
    page,
  }) => {
    // With 'Show completed' off, the completed bullet between alpha and bravo
    // isn't rendered at all -- so the row visually above bravo is alpha, and
    // merging there would relocate bravo's text past a node the user can't see.
    // The blocker is invisible by definition, so this refusal has to say so.
    await load(
      page,
      [
        { id: "one", parentId: null, prevSiblingId: null, text: "alpha" },
        {
          id: "mid",
          parentId: null,
          prevSiblingId: "one",
          text: "done",
          isTask: true,
          completed: true,
        },
        { id: "two", parentId: null, prevSiblingId: "mid", text: "bravo" },
      ],
      { hideCompleted: true },
    );

    // Sanity: the completed bullet really is out of the DOM.
    await expect(text(page, "mid")).toHaveCount(0);

    await caretAt(page, "two", 0);
    await page.keyboard.press("Backspace");

    await expect(outlineRow(page, "two")).toHaveClass(/node-rejected/);
    await expect(page.getByText(/hidden bullet/i)).toBeVisible();
    // Nothing moved: both visible rows are exactly as they were.
    await expect(text(page, "one")).toHaveText("alpha");
    await expect(text(page, "two")).toHaveText("bravo");
    expect(await orderedTexts(page)).toEqual(["alpha", "bravo"]);
  });
});

// Cmd on macOS, Control elsewhere -- the e2e run is chromium on whatever host.
function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}
