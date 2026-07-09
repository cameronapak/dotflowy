import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Completion is now the todos plugin (ADR 0018 D9): the checkbox (Seam F), the
// `[]` autoformat (Seam I), Mod+Enter/Mod+D (Seam D), and `/todo` (Seam C) all
// flow through plugin registrations rather than core branches. This spec is the
// end-to-end lock on those surfaces -- nothing else covered them before.

const MOD = process.platform === "darwin" ? "Meta" : "Control";

const TREE: SeedNode[] = [
  // Empty plain bullets we type into.
  { id: "a", parentId: null, prevSiblingId: null, text: "" },
  { id: "b", parentId: null, prevSiblingId: "a", text: "" },
  // A pre-made task, for the checkbox-click path.
  { id: "c", parentId: null, prevSiblingId: "b", text: "buy milk", isTask: true },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const checkbox = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .checkbox`);

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(text(page, "c")).toBeVisible();
}

test.describe("todos plugin", () => {
  test("`[]` autoformat turns a plain bullet into a task (Seam I + F)", async ({
    page,
  }) => {
    await load(page);

    await text(page, "a").click();
    await page.keyboard.type("[]");

    // The checkbox appears (the slot renders once isTask flips)...
    await expect(checkbox(page, "a")).toBeVisible();
    // ...the marker is stripped...
    expect(await text(page, "a").textContent()).toBe("");
    // ...and it's a fresh task, not completed.
    await expect(text(page, "a")).toHaveAttribute("data-completed", "false");
  });

  test("clicking the checkbox completes / uncompletes (Seam F)", async ({
    page,
  }) => {
    await load(page);

    await checkbox(page, "c").click();
    await expect(text(page, "c")).toHaveAttribute("data-completed", "true");

    await checkbox(page, "c").click();
    await expect(text(page, "c")).toHaveAttribute("data-completed", "false");
  });

  test("Mod+Enter toggles completion on any bullet (Seam D)", async ({
    page,
  }) => {
    await load(page);

    await text(page, "a").click();
    await page.keyboard.type("ship it");
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(text(page, "a")).toHaveAttribute("data-completed", "true");

    await page.keyboard.press(`${MOD}+Enter`);
    await expect(text(page, "a")).toHaveAttribute("data-completed", "false");
  });

  test("the checkbox renders in the zoomed-in title and toggles there (Seam F title slot)", async ({
    page,
  }) => {
    await load(page);

    // Zoom into the task so it becomes the page title (h2), not a list bullet.
    // On a task the checkbox REPLACES the bullet-dot (`row:bullet`), so
    // single-click is toggle -- double-click zooms (plain bullets still
    // single-click zoom). The title checkbox is `title:before-text`.
    await page
      .locator('li[data-node-id="c"] > .outline-row .bullet')
      .dblclick();
    const title = page.locator("h2.zoomed-title");
    await expect(title.locator(".node-text")).toContainText("buy milk");

    const titleCheckbox = title.locator(".checkbox");
    await expect(titleCheckbox).toBeVisible();

    // Clicking it completes the zoomed node (same handler as the row checkbox).
    await titleCheckbox.click();
    await expect(title.locator(".node-text")).toHaveAttribute(
      "data-completed",
      "true",
    );
  });

  test("`/todo` makes a task and `/bullet` reverts it (Seam C)", async ({
    page,
  }) => {
    await load(page);

    // `/` at the start of an empty bullet opens the palette; "todo" matches the
    // plugin command (the only available match), Enter runs it.
    await text(page, "b").click();
    await page.keyboard.type("/todo");
    await expect(page.locator('[role="listbox"]')).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(checkbox(page, "b")).toBeVisible();

    // The bullet is still focused with the "/todo" stripped, so `/bullet` runs
    // the reverse command and the checkbox disappears.
    await page.keyboard.type("/bullet");
    await page.keyboard.press("Enter");
    await expect(checkbox(page, "b")).toHaveCount(0);
  });

  test("Backspace at the start of a task demotes it to a plain bullet", async ({
    page,
  }) => {
    await load(page);

    // Inverse of checkbox-replaces-bullet: caret at the start of a task +
    // Backspace "deletes the checkbox" and restores the bullet-dot, keeping
    // the text. Mirrors the `[]` autoformat / `/bullet` command path.
    await text(page, "c").click();
    await page.evaluate(() => {
      const el = document.querySelector(
        'li[data-node-id="c"] > .outline-row .node-text',
      ) as HTMLElement;
      el.focus();
      const sel = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true); // caret at start
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await expect(checkbox(page, "c")).toBeVisible();
    await page.keyboard.press("Backspace");
    await expect(checkbox(page, "c")).toHaveCount(0);
    // Text is preserved; the bullet-dot is back in the bullet column.
    await expect(text(page, "c")).toContainText("buy milk");
    await expect(
      page.locator('li[data-node-id="c"] > .outline-row .bullet-dot'),
    ).toBeVisible();
  });
});
