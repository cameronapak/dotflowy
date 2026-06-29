import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// A flat top-level list -- the simplest shape to reason about sibling-scoped
// selection (no subtree-implied descendants to track).
const FLAT: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
  { id: "b", parentId: null, prevSiblingId: "a", text: "bravo" },
  { id: "c", parentId: null, prevSiblingId: "b", text: "charlie" },
  { id: "d", parentId: null, prevSiblingId: "c", text: "delta" },
];

// A single-child chain -- the simplest shape to reason about the depth walk at a
// sibling boundary (Shift+Up climbs to the parent, Shift+Down dives to the child)
// with no siblings around to extend into instead.
const CHAIN: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
  { id: "aa", parentId: "a", prevSiblingId: null, text: "alphaalpha" },
  { id: "aaa", parentId: "aa", prevSiblingId: null, text: "alphaalphaalpha" },
];

// A long flat list -- enough rows to overflow a short viewport, so the actions
// menu's on-screen guarantee can be tested past the fold.
const TALL: SeedNode[] = Array.from({ length: 14 }, (_, i) => ({
  id: `n${i}`,
  parentId: null,
  prevSiblingId: i === 0 ? null : `n${i - 1}`,
  text: `node${i}`,
}));

// Assert a bounding box sits fully within the viewport (1px slack for rounding).
function expectInViewport(
  box: { x: number; y: number; width: number; height: number },
  vp: { width: number; height: number },
) {
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
}

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .node-text`);

const li = (page: Page, id: string) => page.locator(`li[data-node-id="${id}"]`);

const focused = (page: Page) => page.locator(".node-text:focus");

const orderedTexts = (page: Page) =>
  page.locator(".outline-row > .node-text").allTextContents();

// Cmd on macOS, Control elsewhere.
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function load(page: Page, tree: SeedNode[] = FLAT) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

// Focus a bullet so it holds the caret (entry point for Shift+arrow / Cmd+A).
async function focus(page: Page, id: string) {
  await text(page, id).click();
  await expect(text(page, id)).toBeFocused();
}

test.describe("Node multi-selection", () => {
  test("the first Shift+arrow press selects ONLY the focused node (entry never extends)", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "d");

    // Cursor on d, Shift+Up: d alone becomes selected -- entry does NOT reach up
    // into c. The caret is gone (selection mode has no caret).
    await page.keyboard.press("Shift+ArrowUp");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "single");
    await expect(li(page, "c")).not.toHaveAttribute("data-selected", /.*/);
    await expect(focused(page)).toHaveCount(0);

    // The SECOND press is what extends the run upward -> [c, d].
    await page.keyboard.press("Shift+ArrowUp");
    await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
  });

  test("Shift+Down extends the run, Shift+Up shrinks toward the anchor", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "a");

    // First press enters selection on the focused node only.
    await page.keyboard.press("Shift+ArrowDown");
    await expect(li(page, "a")).toHaveAttribute("data-selected", "single");
    // Caret is gone while selecting.
    await expect(focused(page)).toHaveCount(0);

    // Extend down -> [a, b].
    await page.keyboard.press("Shift+ArrowDown");
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");

    // Extend to [a, b, c].
    await page.keyboard.press("Shift+ArrowDown");
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "b")).toHaveAttribute("data-selected", "middle");
    await expect(li(page, "c")).toHaveAttribute("data-selected", "bottom");

    // Reverse direction shrinks back toward the anchor -> [a, b].
    await page.keyboard.press("Shift+ArrowUp");
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");
    await expect(li(page, "c")).not.toHaveAttribute("data-selected", /.*/);
  });

  test("Shift extension is a no-op at the last sibling (never crosses parents)", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "d"); // last sibling

    await page.keyboard.press("Shift+ArrowDown");
    // Only d is selected; there is nothing below to extend into.
    await expect(li(page, "d")).toHaveAttribute("data-selected", "single");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "single");
  });

  test("at the sibling boundary, a single-root selection climbs to the parent and dives back into the child", async ({
    page,
  }) => {
    await load(page, CHAIN);
    await focus(page, "aaa");

    // First press selects the focused node itself -- entering never climbs.
    await page.keyboard.press("Shift+ArrowUp");
    await expect(li(page, "aaa")).toHaveAttribute("data-selected", "single");

    // No upper sibling -> the selection moves UP to the parent (the child stays
    // tinted as the parent's implied subtree, but only the root carries an edge).
    await page.keyboard.press("Shift+ArrowUp");
    await expect(li(page, "aa")).toHaveAttribute("data-selected", "single");
    await expect(li(page, "aaa")).not.toHaveAttribute("data-selected", /.*/);

    // Climb again to the top-level grandparent.
    await page.keyboard.press("Shift+ArrowUp");
    await expect(li(page, "a")).toHaveAttribute("data-selected", "single");

    // At the top level there is no parent to climb to -> no-op.
    await page.keyboard.press("Shift+ArrowUp");
    await expect(li(page, "a")).toHaveAttribute("data-selected", "single");

    // Shift+Down dives back into the first visible child, one level per press.
    await page.keyboard.press("Shift+ArrowDown");
    await expect(li(page, "aa")).toHaveAttribute("data-selected", "single");
    await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);

    await page.keyboard.press("Shift+ArrowDown");
    await expect(li(page, "aaa")).toHaveAttribute("data-selected", "single");
  });

  test("Tab indents the selected run under the previous sibling; Shift+Tab outdents it back", async ({
    page,
  }) => {
    await load(page); // FLAT: alpha, bravo, charlie, delta
    await focus(page, "d");
    await page.keyboard.press("Shift+ArrowUp"); // enter -> [d]
    await page.keyboard.press("Shift+ArrowUp"); // extend -> [c, d] -- anchor d, focus c
    await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");

    // Tab: c and d become children of b, in order, and STAY selected.
    await page.keyboard.press("Tab");
    await expect(
      page.locator('li[data-node-id="c"][data-parent-id="b"]'),
    ).toBeVisible();
    await expect(
      page.locator('li[data-node-id="d"][data-parent-id="b"]'),
    ).toBeVisible();
    await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
    // Only alpha + bravo remain at the top level now.
    await expect(
      page.locator("li[data-node-id]:not([data-parent-id])"),
    ).toHaveCount(2);

    // Shift+Tab: outdent back to the top level, right after b, still selected.
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.locator("li[data-node-id]:not([data-parent-id])"),
    ).toHaveCount(4);
    await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
    expect(await orderedTexts(page)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
  });

  test("Tab is a no-op when the run starts at the first child (nothing to indent under)", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "a"); // first sibling -- no previous sibling to indent under
    await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
    await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

    await page.keyboard.press("Tab");
    // Nothing moved; the selection persists at the top level.
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");
    await expect(
      page.locator("li[data-node-id]:not([data-parent-id])"),
    ).toHaveCount(4);
  });

  test("Cmd+A ladder: text -> node -> whole view", async ({ page }) => {
    await load(page);
    await focus(page, "a");

    // Rung 1: select all TEXT in the bullet (native), no node selection yet.
    await page.keyboard.press(`${MOD}+a`);
    expect(
      await text(page, "a").evaluate(() => window.getSelection()?.toString()),
    ).toBe("alpha");
    await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);

    // Rung 2: this node + its subtree (a single-root selection).
    await page.keyboard.press(`${MOD}+a`);
    await expect(li(page, "a")).toHaveAttribute("data-selected", "single");

    // Rung 3: the whole current view -- every top-level node.
    await page.keyboard.press(`${MOD}+a`);
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "b")).toHaveAttribute("data-selected", "middle");
    await expect(li(page, "c")).toHaveAttribute("data-selected", "middle");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
  });

  test("Copy as Markdown copies the selected roots' subtrees", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await load(page);
    await focus(page, "a");
    await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
    await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

    await page.keyboard.press(`${MOD}+c`);
    await expect(page.getByText("Copied as Markdown")).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe("- alpha\n- bravo");
  });

  test("Backspace deletes the selected roots in one batch; undo restores", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "b");
    await page.keyboard.press("Shift+ArrowDown"); // enter -> [b]
    await page.keyboard.press("Shift+ArrowDown"); // extend -> [b, c]

    await page.keyboard.press("Backspace");
    expect(await orderedTexts(page)).toEqual(["alpha", "delta"]);
    // Focus lands on the surviving row above the deleted block.
    await expect(focused(page)).toHaveText("alpha");

    await page.keyboard.press(`${MOD}+z`);
    expect(await orderedTexts(page)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
  });

  test("Escape clears the selection and returns the caret", async ({ page }) => {
    await load(page);
    await focus(page, "a");
    await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
    await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b], focus end = b

    await page.keyboard.press("Escape");
    await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);
    await expect(li(page, "b")).not.toHaveAttribute("data-selected", /.*/);
    // Caret returns to the moving (focus) end.
    await expect(focused(page)).toHaveText("bravo");
  });

  test("a printable key never replaces the selection", async ({ page }) => {
    await load(page);
    await focus(page, "a");
    await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
    await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

    await page.keyboard.press("x");
    // Selection persists; no text was replaced.
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");
    expect(await orderedTexts(page)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
  });

  test("a click leaves selection mode", async ({ page }) => {
    await load(page);
    await focus(page, "a");
    await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
    await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");

    await text(page, "d").click();
    await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);
    await expect(text(page, "d")).toBeFocused();
  });

  test("actions menu: Move relocates the whole run under one destination", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "a");
    await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
    await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

    const menu = page.getByRole("listbox");
    // Anchor to the label: "Send to Today"'s description also contains "Move".
    await menu.getByRole("option", { name: /^Move/ }).click();

    // The destination picker opens; pick delta (not in the moved subtrees).
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.type("delta");
    await dialog.getByRole("option", { name: "delta" }).click();

    await expect(page.getByText("Moved 2 nodes to delta")).toBeVisible();
    // Both moved roots are now children of delta (their data-parent-id).
    await expect(
      page.locator('li[data-node-id="a"][data-parent-id="d"]'),
    ).toBeVisible();
    await expect(
      page.locator('li[data-node-id="b"][data-parent-id="d"]'),
    ).toBeVisible();
    // They are no longer top-level (only charlie + delta remain at the top).
    await expect(
      page.locator("li[data-node-id]:not([data-parent-id])"),
    ).toHaveCount(2);
  });

  test("actions menu: To-do converts every selected root in one step", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "a");
    await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
    await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

    // The actions menu auto-appears anchored to the active (focus) edge.
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    await menu.getByRole("option", { name: "To-do" }).click();

    // Both selected roots are now tasks (a checkbox appears on each).
    await expect(li(page, "a").locator(".checkbox")).toBeVisible();
    await expect(li(page, "b").locator(".checkbox")).toBeVisible();
    // The untouched siblings stay plain bullets.
    await expect(li(page, "c").locator(".checkbox")).toHaveCount(0);
  });

  test("actions menu follows the active edge DOWN, anchored below the newest node", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "a");

    const menu = page.getByRole("listbox");
    const rowBox = async (id: string) =>
      (await page
        .locator(`li[data-node-id="${id}"] > .outline-row`)
        .boundingBox())!;
    const menuBox = async () => (await menu.boundingBox())!;

    // Enter on a single node: the menu sits just below the focused row (there's
    // plenty of room below in the default tall viewport, so no flip).
    await page.keyboard.press("Shift+ArrowDown"); // -> [a], focus a
    await expect(menu).toBeVisible();
    let row = await rowBox("a");
    let m = await menuBox();
    expect(m.y).toBeGreaterThanOrEqual(row.y + row.height - 1);
    expect(m.y).toBeLessThanOrEqual(row.y + row.height + 16);
    const yBelowA = m.y;

    // Extend down twice: the menu drops to the NEW bottom node each time, never
    // parking over the run's text up top.
    await page.keyboard.press("Shift+ArrowDown"); // -> [a, b], focus b
    await page.keyboard.press("Shift+ArrowDown"); // -> [a, b, c], focus c
    row = await rowBox("c");
    m = await menuBox();
    expect(m.y).toBeGreaterThan(yBelowA + 10); // it moved down with the selection
    expect(m.y).toBeGreaterThanOrEqual(row.y + row.height - 1); // below c
    expect(m.y).toBeLessThanOrEqual(row.y + row.height + 16);
  });

  test("actions menu stays fully on screen when the run grows to the TOP edge", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "d");

    // Grow the run all the way up so the focus lands on the top-most row, where
    // the old top-anchored menu clipped off the top of the viewport.
    await page.keyboard.press("Shift+ArrowUp"); // -> [d]
    await page.keyboard.press("Shift+ArrowUp"); // -> [c, d]
    await page.keyboard.press("Shift+ArrowUp"); // -> [b, c, d]
    await page.keyboard.press("Shift+ArrowUp"); // -> [a, b, c, d], focus a (top)

    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    // floating-ui flips the menu below the top node rather than letting it clip:
    // the whole box is within the viewport (the bug in the report).
    expectInViewport((await menu.boundingBox())!, page.viewportSize()!);
  });

  test("actions menu stays on screen extending DOWN past the fold", async ({
    page,
  }) => {
    // A short viewport so the lower rows sit past the fold.
    await page.setViewportSize({ width: 1000, height: 420 });
    await load(page, TALL);
    await focus(page, "n0");

    await page.keyboard.press("Shift+ArrowDown"); // enter -> [n0]
    for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowDown");

    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    // shift()/flip() keep the menu in view even though the run runs past the fold.
    expectInViewport((await menu.boundingBox())!, page.viewportSize()!);
  });
});
