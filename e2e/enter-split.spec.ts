import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  STANDARD_TREE,
  text,
  type SeedNode,
} from "./fixtures";

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
  await openSeededOutline(page, { anchorId: tree[0]!.id });
}

// Focus `id` and drop the caret at absolute character offset `col`. We set the
// Selection range directly rather than press Home/Arrow keys: on macOS Chromium
// those don't reliably move the caret inside a contentEditable, and a plain
// click lands past the text. This mirrors the app's own setCaretOffset walk.
async function caretAt(page: Page, id: string, col: number) {
  await placeCaret(text(page, id), col);
}

test("Enter replaces a backward selection, undo restores its direction, and immediate typing can split again", async ({
  context,
}) => {
  for (const remount of [false, true]) {
    // Each page owns its fixture socket and outline, including optimistic edits.
    const page = await context.newPage();
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "ABCDEF" },
    ]);
    await text(page, "n").evaluate((el) => {
      el.focus();
      const node = el.firstChild!;
      window.getSelection()!.setBaseAndExtent(node, 4, node, 2);
    });
    await page.keyboard.press("Enter");
    await expect.poll(() => orderedTexts(page)).toEqual(["AB", "EF"]);
    await expect(focused(page)).toHaveText("EF");

    if (remount) {
      // Leave the editing root without changing history. Undo must mount the
      // original row again; its mount/FocusPass must not expose the saved range
      // while restore still blocks input.
      await row(page, "n")
        .getByRole("button", { name: "Zoom in", exact: true })
        .click();
      await expect(page).toHaveURL(/\/n$/);
      await expect(text(page, "n")).toHaveCount(0);
    }

    // Slow frames expose the interval between restoring the selection and
    // releasing history's input guard. This perturbs scheduling, not readiness:
    // the next edit still starts as soon as the public selection is restored.
    await page.evaluate(() => {
      const requestFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        requestFrame((time) => {
          setTimeout(() => callback(time), 100);
        });
    });

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => orderedTexts(page)).toEqual(["ABCDEF"]);
    await expect
      .poll(
        () =>
          text(page, "n").evaluate((el) => {
            const sel = window.getSelection()!;
            return {
              text: sel.toString(),
              anchor: sel.anchorOffset,
              focus: sel.focusOffset,
              inside: el.contains(sel.anchorNode) && el.contains(sel.focusNode),
            };
          }),
        { intervals: [10] },
      )
      .toEqual({ text: "CD", anchor: 4, focus: 2, inside: true });

    // No focus assertions or animation-frame waits between native editing handoffs.
    await page.keyboard.press("Enter");
    await page.keyboard.type("X");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Y");
    await expect.poll(() => orderedTexts(page)).toEqual(["AB", "X", "YEF"]);
    await page.close();
  }
});

test("Enter removes selected prefixes, suffixes, and whole text, including an expanded parent", async ({
  page,
}) => {
  for (const { start, end, children, expected } of [
    { start: 0, end: 2, children: false, expected: ["", "CDEF"] },
    { start: 2, end: 6, children: false, expected: ["AB", ""] },
    { start: 0, end: 6, children: false, expected: ["", ""] },
    { start: 2, end: 6, children: true, expected: ["AB", "", "child"] },
  ]) {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "ABCDEF" },
      ...(children
        ? [{ id: "c", parentId: "n", prevSiblingId: null, text: "child" }]
        : []),
    ]);
    await text(page, "n").evaluate(
      (el, { start, end }) => {
        el.focus();
        window
          .getSelection()!
          .setBaseAndExtent(el.firstChild!, start, el.firstChild!, end);
      },
      { start, end },
    );
    await page.keyboard.press("Enter");
    await expect.poll(() => orderedTexts(page)).toEqual(expected);
    if (children)
      await expect(rows(page).nth(1)).toHaveAttribute("data-parent-id", "n");
    else
      await expect(rows(page).nth(1)).not.toHaveAttribute(
        "data-parent-id",
        /./,
      );
    await expect(focused(page)).toHaveText(expected[1]!);
  }
});

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
  await expect.poll(() => orderedTexts(page)).toEqual(["alpha", "Xbravo"]);
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
  await expect.poll(() => orderedTexts(page)).toEqual(["alpha", "beta"]);
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
  await expect.poll(() => orderedTexts(page)).toEqual(["", "alpha"]);
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
  await expect.poll(() => orderedTexts(page)).toEqual(["", "Xalpha"]);
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
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["", "P1", "C1", "C2", "P2"]);
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
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["Alpha", "", "Alpha one", "Alpha two", "Bravo", "Charlie"]);
  // The blank line is alpha's new first child, and the rest of the chain
  // (alpha-1 then alpha-2) survived intact.
  await expect(rows(page).nth(1)).toHaveAttribute("data-parent-id", "alpha");
  await expect(row(page, "alpha-2")).toHaveAttribute("data-parent-id", "alpha");
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
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["Alpha", "", "Alpha one", "Alpha two", "Bravo", "Charlie"]);
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

  await page.keyboard.press("ControlOrMeta+z");

  // One undo collapses the split back to the original single bullet.
  await expect(text(page, "n")).toHaveText("alphabravo");
  await expect.poll(() => orderedTexts(page)).toEqual(["alphabravo"]);
});

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
  await expect.poll(() => orderedTexts(page)).toEqual(["alphabravo"]);
  // The caret sits at the SEAM, not at either end: typing lands between the
  // two halves.
  await expect(text(page, "n")).toBeFocused();
  await page.keyboard.type("X");
  await expect(text(page, "n")).toHaveText("alphaXbravo");
});

for (const collapsed of [undefined, false, true]) {
  test(`Enter at the START then Backspace preserves identity (${collapsed === undefined ? "leaf" : collapsed ? "collapsed parent" : "expanded parent"})`, async ({
    page,
  }) => {
    // Enter at offset 0 inserts a blank ABOVE and leaves focus put (#326), so
    // this pair reads as an undo. Appending onto the blank would restore the
    // TEXT while quietly moving it onto the blank's id -- the identity move that
    // Enter arm exists to prevent. Asserting on the id, not just the text, is
    // the whole point of this test.
    await load(page, [
      {
        id: "keepme",
        parentId: null,
        prevSiblingId: null,
        text: "alpha",
        collapsed,
      },
      ...(collapsed === undefined
        ? []
        : [
            {
              id: "kid",
              parentId: "keepme",
              prevSiblingId: null,
              text: "child",
            },
          ]),
    ]);

    const visible = collapsed === false ? ["alpha", "child"] : ["alpha"];
    await caretAt(page, "keepme", 0);
    await page.keyboard.press("Enter");
    await expect.poll(() => orderedTexts(page)).toEqual(["", ...visible]);

    await page.keyboard.press("Backspace");

    await expect.poll(() => orderedTexts(page)).toEqual(visible);
    // The ORIGINAL node is the survivor, not a look-alike carrying its text.
    await expect(text(page, "keepme")).toHaveText("alpha");
    await expect(rows(page)).toHaveCount(visible.length);
    await expect(text(page, "keepme")).toBeFocused();
    await expect
      .poll(() =>
        text(page, "keepme").evaluate((el) => {
          const selection = window.getSelection();
          if (
            !selection?.isCollapsed ||
            !selection.anchorNode ||
            !el.contains(selection.anchorNode)
          )
            return null;
          const before = document.createRange();
          before.selectNodeContents(el);
          before.setEnd(selection.anchorNode, selection.anchorOffset);
          return before.toString().length;
        }),
      )
      .toBe(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => orderedTexts(page)).toEqual(["", ...visible]);
    // Replay paints before its persistence and caret work finish. Wait for the
    // existing edit gate before sending another shortcut or typing.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = "/src/data/history.ts";
          return (await import(path)).getHistoryState().busy;
        }),
      )
      .toBe(false);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => orderedTexts(page)).toEqual(visible);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = "/src/data/history.ts";
          return (await import(path)).getHistoryState().busy;
        }),
      )
      .toBe(false);
    // Caret is back at the start, where the user left it.
    await expect(text(page, "keepme")).toBeFocused();
    await page.keyboard.type("X");
    await expect(text(page, "keepme")).toHaveText("Xalpha");
    await page.reload();
    await text(page, "keepme").waitFor({ state: "visible" });
    await expect(text(page, "keepme")).toHaveText("Xalpha");
    await expect
      .poll(() => orderedTexts(page))
      .toEqual(["Xalpha", ...visible.slice(1)]);
    if (collapsed !== undefined) {
      await row(page, "keepme")
        .getByRole("button", {
          name: collapsed ? "Expand" : "Collapse",
          exact: true,
        })
        .click();
      await expect(text(page, "kid")).toHaveCount(collapsed ? 1 : 0);
      if (collapsed)
        await expect(row(page, "kid")).toHaveAttribute(
          "data-parent-id",
          "keepme",
        );
    }
  });
}

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
  await expect.poll(() => orderedTexts(page)).toEqual(["alphabravo"]);
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

  await page.keyboard.press("ControlOrMeta+z");

  // One undo puts back the split: the source node's text AND the row that was
  // merged away. (The Enter remains its own separate undo step.)
  await expect(text(page, "n")).toHaveText("alpha");
  await expect.poll(() => orderedTexts(page)).toEqual(["alpha", "bravo"]);
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
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["alpha", "parent", "kid"]);

  // The class clears itself on animationend, so a repeat can re-trigger it.
  await expect(outlineRow(page, "par")).not.toHaveClass(/node-rejected/, {
    timeout: 4000,
  });

  // ...and the first child DOES merge into its parent (a different depth), so
  // the refusal above isn't just a dead keymap.
  await caretAt(page, "kid", 0);
  await page.keyboard.press("Backspace");
  await expect(text(page, "par")).toHaveText("parentkid");
  await expect.poll(() => orderedTexts(page)).toEqual(["alpha", "parentkid"]);
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
  await expect.poll(() => orderedTexts(page)).toEqual(["alpha", "bravo"]);
});
