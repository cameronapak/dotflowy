import { expect, test, type Page } from "@playwright/test";

import {
  placeCaret,
  seedOutline,
  STANDARD_TREE,
  text,
  type SeedNode,
} from "./fixtures";

async function load(
  page: Page,
  tree: SeedNode[] = STANDARD_TREE,
  opts?: { hideCompleted?: boolean },
) {
  await seedOutline(page, tree);
  if (opts?.hideCompleted) {
    // Must be set before goto so the provider reads the persisted value on
    // first render; setting it after navigation wouldn't flip showCompleted off
    // until a reload.
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:show-completed", "false");
    });
  }
  await page.goto("/");
  // Wait for the seeded tree to render before driving the keyboard. Any node
  // works; use the first so this holds for custom trees too.
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

test("ArrowDown walks focus through every visible bullet, top to bottom", async ({
  page,
}) => {
  await load(page);

  const order = ["alpha", "alpha-1", "alpha-2", "bravo", "charlie"];
  await text(page, order[0]!).click();
  await expect(text(page, order[0]!)).toBeFocused();

  for (let i = 1; i < order.length; i++) {
    await page.keyboard.press("ArrowDown");
    await expect(text(page, order[i]!)).toBeFocused();
  }

  // Past the last bullet there's nowhere to go -- focus must hold, not jump.
  await page.keyboard.press("ArrowDown");
  await expect(text(page, "charlie")).toBeFocused();
});

test("ArrowUp walks focus back up through every visible bullet", async ({
  page,
}) => {
  await load(page);

  const order = ["charlie", "bravo", "alpha-2", "alpha-1", "alpha"];
  await text(page, order[0]!).click();
  await expect(text(page, order[0]!)).toBeFocused();

  for (let i = 1; i < order.length; i++) {
    await page.keyboard.press("ArrowUp");
    await expect(text(page, order[i]!)).toBeFocused();
  }

  // At the very top there's nowhere up to go -- focus holds on the first bullet.
  await page.keyboard.press("ArrowUp");
  await expect(text(page, "alpha")).toBeFocused();
});

test("a completed bullet hidden by 'Show completed' off is skipped", async ({
  page,
}) => {
  // When 'Show completed' is off, completed nodes are filtered out of the
  // DOM entirely (see useVisibleChildIds). Arrow nav must walk only the
  // *mounted* bullets -- landing on a hidden id is a silent no-op that pins
  // focus. Regression for the bug where findVisibleNeighbor returned an
  // unmounted completed node as the neighbor.
  //
  //   A
  //     A1
  //       A1a
  //       A1b
  //     A2   <- completed, hidden
  //   B
  //   C
  // Visible order: A, A1, A1a, A1b, B, C.
  const tree: SeedNode[] = [
    { id: "A", parentId: null, prevSiblingId: null, text: "A" },
    { id: "B", parentId: null, prevSiblingId: "A", text: "B" },
    { id: "C", parentId: null, prevSiblingId: "B", text: "C" },
    { id: "A1", parentId: "A", prevSiblingId: null, text: "A1" },
    {
      id: "A2",
      parentId: "A",
      prevSiblingId: "A1",
      text: "A2",
      isTask: true,
      completed: true,
    },
    { id: "A1a", parentId: "A1", prevSiblingId: null, text: "A1a" },
    { id: "A1b", parentId: "A1", prevSiblingId: "A1a", text: "A1b" },
  ];
  await load(page, tree, { hideCompleted: true });

  // Sanity: A2 is filtered out of the DOM.
  await expect(text(page, "A2")).toHaveCount(0);

  // Down from A1b (sits right above the hidden A2) must skip A2 -> B.
  await text(page, "A1b").click();
  await expect(text(page, "A1b")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(text(page, "B")).toBeFocused();

  // And up from B must skip back over A2 -> A1b.
  await page.keyboard.press("ArrowUp");
  await expect(text(page, "A1b")).toBeFocused();
});

test("single-line bullets cross in one press even with code/tag chips", async ({
  page,
}) => {
  // Inline `code` and #tag both inject extra DOM (and a shorter caret) inside
  // .node-text. This guards that a single visual line still crosses on the
  // first press -- the threshold must not eat a press near a chip.
  await load(page, [
    { id: "p", parentId: null, prevSiblingId: null, text: "Plain parent" },
    {
      id: "code",
      parentId: null,
      prevSiblingId: "p",
      text: "Has `inline` code",
    },
    {
      id: "tag",
      parentId: null,
      prevSiblingId: "code",
      text: "Has #urgent tag",
    },
  ]);

  const order = ["p", "code", "tag"];
  await text(page, order[0]!).click();
  await placeCaret(text(page, order[0]!), "end");
  for (let i = 1; i < order.length; i++) {
    await page.keyboard.press("ArrowDown");
    await expect(text(page, order[i]!)).toBeFocused();
  }
  for (let i = order.length - 2; i >= 0; i--) {
    await page.keyboard.press("ArrowUp");
    await expect(text(page, order[i]!)).toBeFocused();
  }
});

test("a collapsed parent's hidden children are skipped", async ({ page }) => {
  const collapsed = STANDARD_TREE.map((n) =>
    n.id === "alpha" ? { ...n, collapsed: true } : n,
  );
  await load(page, collapsed);

  await text(page, "alpha").click();
  await expect(text(page, "alpha")).toBeFocused();

  // alpha-1 / alpha-2 are hidden under the collapsed alpha, so Down lands on
  // the next *visible* bullet, bravo -- not into the hidden subtree.
  await page.keyboard.press("ArrowDown");
  await expect(text(page, "bravo")).toBeFocused();

  await page.keyboard.press("ArrowUp");
  await expect(text(page, "alpha")).toBeFocused();
});

test("arrows walk the FILTERED rows while a ?q= filter is active", async ({
  page,
}) => {
  // Regression: findVisibleNeighbor walked the UNFILTERED tree, so with
  // ?q=#go active the computed neighbor was often a row the filter pruned
  // out of the DOM -- an unmounted target is a silent focus no-op ("can't
  // move between nodes while filtering"). Nav must walk exactly what
  // renders: matches, revealed descendants, AND dimmed ancestor context.
  //
  //   A #go
  //   P            (dimmed context: untagged, has a tagged child)
  //     K #go
  //   B            (untagged, no tagged descendant -> filtered OUT)
  //   C #go
  //   P2 collapsed (dimmed context; filter force-descends to reveal D)
  //     D #go
  // Rendered order under #go: A, P, K, C, P2, D.
  const tree: SeedNode[] = [
    { id: "A", parentId: null, prevSiblingId: null, text: "alpha #go" },
    { id: "P", parentId: null, prevSiblingId: "A", text: "parent" },
    { id: "K", parentId: "P", prevSiblingId: null, text: "kid #go" },
    { id: "B", parentId: null, prevSiblingId: "P", text: "bravo" },
    { id: "C", parentId: null, prevSiblingId: "B", text: "charlie #go" },
    {
      id: "P2",
      parentId: null,
      prevSiblingId: "C",
      text: "papa",
      collapsed: true,
    },
    { id: "D", parentId: "P2", prevSiblingId: null, text: "deep #go" },
  ];
  await seedOutline(page, tree);
  await page.goto("/?q=%23go");
  await expect(text(page, "A")).toBeVisible();
  // Sanity: B is pruned out of the DOM; D is revealed despite P2's collapse.
  await expect(text(page, "B")).toHaveCount(0);
  await expect(text(page, "D")).toBeVisible();

  const order = ["A", "P", "K", "C", "P2", "D"];
  await text(page, order[0]!).click();
  await expect(text(page, order[0]!)).toBeFocused();
  for (let i = 1; i < order.length; i++) {
    await page.keyboard.press("ArrowDown");
    await expect(text(page, order[i]!)).toBeFocused();
  }
  // Bottom of the filtered view: focus holds.
  await page.keyboard.press("ArrowDown");
  await expect(text(page, "D")).toBeFocused();
  // And the walk reverses cleanly (D -> P2 crosses the force-descend seam).
  for (let i = order.length - 2; i >= 0; i--) {
    await page.keyboard.press("ArrowUp");
    await expect(text(page, order[i]!)).toBeFocused();
  }
});

test("ArrowLeft/ArrowRight snake between adjacent visible bullets", async ({
  page,
}) => {
  await load(page);

  await placeCaret(text(page, "alpha"), "end");
  await page.keyboard.press("ArrowRight");
  await expect(text(page, "alpha-1")).toBeFocused();
  await page.keyboard.type("!");
  await expect(text(page, "alpha-1")).toHaveText("!Alpha one");

  await placeCaret(text(page, "bravo"), "start");
  await page.keyboard.press("ArrowLeft");
  await expect(text(page, "alpha-2")).toBeFocused();
  await page.keyboard.type("!");
  await expect(text(page, "alpha-2")).toHaveText("Alpha two!");
});

test("backspacing an empty bullet away focuses the row ABOVE, not below", async ({
  page,
}) => {
  // Workflowy behavior: deleting a bullet by emptying it lands the caret on
  // the previous row, never the next one. Regression for focus jumping down.
  await load(page, [
    { id: "above", parentId: null, prevSiblingId: null, text: "above" },
    { id: "mid", parentId: null, prevSiblingId: "above", text: "" },
    { id: "below", parentId: null, prevSiblingId: "mid", text: "below" },
  ]);

  await text(page, "mid").click();
  await expect(text(page, "mid")).toBeFocused();

  // Backspace at the start of the now-empty bullet deletes it.
  await page.keyboard.press("Backspace");

  // It's gone, and focus moved UP to "above" -- not down to "below".
  await expect(page.locator('li[data-node-id="mid"]')).toHaveCount(0);
  await expect(text(page, "above")).toBeFocused();
  await expect(text(page, "below")).not.toBeFocused();
  // ...and it DELETED rather than joined: the row above is untouched, and the
  // caret sits at its end. Pins the emptiness gate now that it reads the
  // reconstructed source instead of raw textContent (ADR 0005).
  await expect(text(page, "above")).toHaveText("above");
  await page.keyboard.type("!");
  await expect(text(page, "above")).toHaveText("above!");
});

test.describe("software-keyboard Backspace", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("deletes an empty plain node immediately on focus without beforeinput", async ({
    page,
  }) => {
    await load(page, [
      { id: "above", parentId: null, prevSiblingId: null, text: "above" },
      { id: "empty", parentId: null, prevSiblingId: "above", text: "" },
      { id: "below", parentId: null, prevSiblingId: "empty", text: "below" },
    ]);

    const prevented = await text(page, "empty").evaluate((el: HTMLElement) => {
      // Keep focus and keydown in the same turn. On an empty contentEditable,
      // iPhone Safari emits keydown/keyup but no beforeinput or input event.
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const event = new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });

    expect(prevented).toBe(true);
    await expect(text(page, "empty")).toHaveCount(0);
    await expect(text(page, "above")).toBeFocused();
    await expect(text(page, "above")).toHaveText("above");
    await expect(text(page, "below")).toHaveText("below");
  });
});
