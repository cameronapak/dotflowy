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

async function load(page: Page, tree: SeedNode[] = TREE) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, "c")).toBeVisible();
}

async function caretAt(page: Page, id: string, offset: number) {
  await text(page, id).evaluate((el: HTMLElement, pos) => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    if (el.firstChild) range.setStart(el.firstChild, pos);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, offset);
}

// Software keyboards can deliver deletion intent without a Backspace keydown.
// Dispatch the native event, not a React callback or a keyboard shortcut.
async function deleteBackward(page: Page, isComposing = false) {
  return text(page, "c").evaluate((el, composing) => {
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
      isComposing: composing,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, isComposing);
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

  test("desktop Backspace removes the checkbox before deleting an empty task", async ({
    page,
  }) => {
    await load(
      page,
      TREE.map((n) => (n.id === "c" ? { ...n, text: "" } : n)),
    );
    await caretAt(page, "c", 0);

    await page.keyboard.press("Backspace");
    await expect(checkbox(page, "c")).toHaveCount(0);
    await expect(text(page, "c")).toBeFocused();
    await expect(text(page, "c")).toHaveText("");

    // The prevented keydown must not also run the mobile deletion path and
    // delete the newly-demoted node. A SECOND press retains normal deletion.
    await page.keyboard.press("Backspace");
    await expect(text(page, "c")).toHaveCount(0);
  });

  test.describe("software-keyboard deletion", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });

    test("Backspace alone works immediately on focus, without beforeinput", async ({
      page,
    }) => {
      await load(
        page,
        TREE.map((n) => (n.id === "c" ? { ...n, text: "" } : n)),
      );
      const prevented = await text(page, "c").evaluate((el: HTMLElement) => {
        // Keep focus and keydown in the same turn: waiting after focus would
        // hide a handler that depends on React's focus registration catching up.
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        // The iPhone trace contains only keydown/keyup on an empty editor.
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
      await expect(checkbox(page, "c")).toHaveCount(0);
      await expect(text(page, "c")).toBeFocused();
      await expect(page.locator("li[data-node-id]")).toHaveCount(3);

      // Undo restores the checkbox on the same node.
      await page.keyboard.press(`${MOD}+z`);
      await expect(checkbox(page, "c")).toBeVisible();
    });

    test("Shift+Backspace demotes once, but modified or composing keydowns do not", async ({
      page,
    }) => {
      await load(page);
      await caretAt(page, "c", 0);
      const prevented = await text(page, "c").evaluate((el) =>
        [
          { ctrlKey: true },
          { altKey: true },
          { metaKey: true },
          { isComposing: true },
        ].map((modifiers) => {
          const event = new KeyboardEvent("keydown", {
            key: "Backspace",
            bubbles: true,
            cancelable: true,
            ...modifiers,
          });
          el.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      );
      expect(prevented).toEqual([false, false, false, false]);
      await expect(checkbox(page, "c")).toBeVisible();

      await page.keyboard.press("Shift+Backspace");
      await expect(checkbox(page, "c")).toHaveCount(0);
      await expect(text(page, "c")).toHaveText("buy milk");
      await expect(text(page, "c")).toBeFocused();
      await page.keyboard.press(`${MOD}+z`);
      await expect(checkbox(page, "c")).toBeVisible();
      await expect(text(page, "c")).toHaveText("buy milk");
    });

    test("an empty task becomes a bullet, keeps focus, and undo restores its checkbox", async ({
      page,
    }) => {
      await load(
        page,
        TREE.map((n) => (n.id === "c" ? { ...n, text: "" } : n)),
      );
      await caretAt(page, "c", 0);

      expect(await deleteBackward(page)).toBe(true);
      await expect(checkbox(page, "c")).toHaveCount(0);
      await expect(text(page, "c")).toBeFocused();
      await expect(text(page, "c")).toHaveText("");

      await page.keyboard.press(`${MOD}+z`);
      await expect(checkbox(page, "c")).toBeVisible();
      await expect(text(page, "c")).toHaveText("");
    });

    test("deleting the last character leaves a task until the next deletion intent", async ({
      page,
    }) => {
      await load(
        page,
        TREE.map((n) => (n.id === "c" ? { ...n, text: "x" } : n)),
      );
      await caretAt(page, "c", 1);

      // A real browser deletion exercises beforeinput + input together. It
      // must delete the character without converting the now-empty task.
      await page.keyboard.press("Backspace");
      await expect(text(page, "c")).toHaveText("");
      await expect(checkbox(page, "c")).toBeVisible();

      expect(await deleteBackward(page)).toBe(true);
      await expect(checkbox(page, "c")).toHaveCount(0);
      await expect(text(page, "c")).toBeFocused();
      await page.reload();
      await expect(text(page, "c")).toBeVisible();
      await expect(checkbox(page, "c")).toHaveCount(0);
      await expect(text(page, "c")).toHaveText("");
    });

    test("only a collapsed caret at the start converts, never a selection or composition", async ({
      page,
    }) => {
      await load(page);
      await caretAt(page, "c", 3);
      expect(await deleteBackward(page)).toBe(false);
      await expect(checkbox(page, "c")).toBeVisible();

      await text(page, "c").evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
      });
      expect(await deleteBackward(page)).toBe(false);
      await expect(checkbox(page, "c")).toBeVisible();

      await caretAt(page, "c", 0);
      expect(await deleteBackward(page, true)).toBe(false);
      await expect(checkbox(page, "c")).toBeVisible();

      // Match desktop behavior for a nonempty task at the start, too. Text
      // remains intact, rather than joining this row into its predecessor.
      expect(await deleteBackward(page)).toBe(true);
      await expect(checkbox(page, "c")).toHaveCount(0);
      await expect(text(page, "c")).toHaveText("buy milk");
      await expect(text(page, "c")).toBeFocused();
    });
  });

  test("the checkbox hitbox does not reach into the text (ADR 0029)", async ({
    page,
  }) => {
    // Regression guard: shadcn's vendored ui/checkbox.tsx ships an invisible
    // `after:-inset-x-3` that inflates the 16px box to 40px wide. The checkbox
    // only has 6px of clearance to the text, so that arm overshoots by 6px and
    // hit-tests ABOVE the static text span (it's positioned, the span isn't) --
    // clicking the first character toggled the task instead of placing a caret.
    // Asserted by asking the browser what it would actually hit, rather than by
    // reading back the CSS we just wrote.
    await load(page);
    // The first character's own rect. NOT `.node-text`'s box: the checkbox
    // `float: left`s inside `.row-body`, so it's out of flow and the span's box
    // starts UNDERNEATH it -- only the text visually flows around it. A click at
    // the span's own x=0 legitimately hits the checkbox and proves nothing.
    const hit = await page.evaluate(() => {
      const li = document.querySelector('li[data-node-id="c"]')!;
      // SAFETY: load waits for this row's .node-text, which renders as an HTML span.
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
