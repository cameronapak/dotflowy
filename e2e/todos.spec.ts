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
  {
    id: "c",
    parentId: null,
    prevSiblingId: "b",
    text: "buy milk",
    isTask: true,
  },
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
    // The checkbox is a title slot (`title:before-text`), so it must render here
    // too -- and stay interactive.
    await page.locator('li[data-node-id="c"] > .outline-row .bullet').click();
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

  test("the checkbox hitbox does not reach into the text (ADR 0029)", async ({
    page,
  }) => {
    // Regression guard: shadcn's vendored ui/checkbox.tsx ships an invisible
    // `after:-inset-x-3` that inflates the 16px box to 40px wide. The checkbox
    // only has 6px of clearance to the text, so that arm overshoots by 6px and
    // hit-tests ABOVE the static text span (it's positioned, the span isn't) --
    // clicking the first character toggled the task instead of placing a caret.
    // Asserts the countable invariant, not a wall clock: what does the browser
    // say is under the text's first character?
    await load(page);
    // The first character's own rect. NOT `.node-text`'s box: the checkbox
    // `float: left`s inside `.row-body`, so it's out of flow and the span's box
    // starts UNDERNEATH it -- only the text visually flows around it. A click at
    // the span's own x=0 legitimately hits the checkbox and proves nothing.
    const hit = await page.evaluate(() => {
      const li = document.querySelector('li[data-node-id="c"]')!;
      const span = li.querySelector(".node-text")! as HTMLElement;
      const range = document.createRange();
      range.setStart(span.firstChild!, 0);
      range.setEnd(span.firstChild!, 1);
      const r = range.getBoundingClientRect();
      const x = r.left + 1;
      const y = r.top + r.height / 2;
      const el = document.elementFromPoint(x, y);
      return {
        x,
        y,
        insideText: !!el?.closest(".node-text"),
        onCheckbox: !!el?.closest(".checkbox"),
      };
    });
    expect(hit.onCheckbox).toBe(false);
    expect(hit.insideText).toBe(true);

    // And the click that follows from it places a caret rather than completing.
    await page.mouse.click(hit.x, hit.y);
    await expect(text(page, "c")).not.toHaveAttribute("data-completed", "true");
    const caretInText = await text(page, "c").evaluate((el) => {
      const sel = window.getSelection();
      return !!sel && sel.rangeCount > 0 && el.contains(sel.anchorNode);
    });
    expect(caretInText).toBe(true);
  });
});
