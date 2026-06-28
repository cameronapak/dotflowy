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
  test("Shift+Down extends the run, Shift+Up shrinks toward the anchor", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "a");

    // Enter selection: anchor a, focus moves down to b -> [a, b].
    await page.keyboard.press("Shift+ArrowDown");
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");
    // Caret is gone while selecting.
    await expect(focused(page)).toHaveCount(0);

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
    await page.keyboard.press("Shift+ArrowDown"); // [a, b]

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
    await page.keyboard.press("Shift+ArrowDown"); // [b, c]

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
    await page.keyboard.press("Shift+ArrowDown"); // [a, b], focus end = b

    await page.keyboard.press("Escape");
    await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);
    await expect(li(page, "b")).not.toHaveAttribute("data-selected", /.*/);
    // Caret returns to the moving (focus) end.
    await expect(focused(page)).toHaveText("bravo");
  });

  test("a printable key never replaces the selection", async ({ page }) => {
    await load(page);
    await focus(page, "a");
    await page.keyboard.press("Shift+ArrowDown"); // [a, b]

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
    await page.keyboard.press("Shift+ArrowDown"); // [a, b]
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
    await page.keyboard.press("Shift+ArrowDown"); // [a, b]

    const menu = page.getByRole("listbox");
    // Anchor to the label: "Send to Today"'s description also contains "Move".
    await menu.getByRole("option", { name: /^Move/ }).click();

    // The destination picker opens; pick delta (not in the moved subtrees).
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.type("delta");
    await dialog.getByRole("option", { name: "delta" }).click();

    await expect(page.getByText("Moved 2 nodes to delta")).toBeVisible();
    // Both moved roots are now children of delta, in order.
    await expect(li(page, "d").locator('li[data-node-id="a"]')).toBeVisible();
    await expect(li(page, "d").locator('li[data-node-id="b"]')).toBeVisible();
    // They are no longer top-level (only charlie + delta remain at the top).
    await expect(
      page.locator(".outline-list > li[data-node-id]"),
    ).toHaveCount(2);
  });

  test("actions menu: To-do converts every selected root in one step", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "a");
    await page.keyboard.press("Shift+ArrowDown"); // [a, b]

    // The actions menu auto-appears anchored to the selection's top row.
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    await menu.getByRole("option", { name: "To-do" }).click();

    // Both selected roots are now tasks (a checkbox appears on each).
    await expect(li(page, "a").locator(".checkbox")).toBeVisible();
    await expect(li(page, "b").locator(".checkbox")).toBeVisible();
    // The untouched siblings stay plain bullets.
    await expect(li(page, "c").locator(".checkbox")).toHaveCount(0);
  });
});
