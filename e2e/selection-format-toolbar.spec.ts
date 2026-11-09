import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  seedOutline,
  text,
  type SeedNode,
} from "./fixtures";

// Desktop selection formatting toolbar (ADR 0036). A fine-pointer-only floating
// capsule that appears over a text selection inside one bullet/title and toggles
// bold/italic/strike/underline/highlight + create-link. It's dumb chrome over
// the same emphasis/highlight/link machinery the keyboard uses. Playwright's
// default desktop context reports `(pointer: fine)`, so the bar mounts here.

const bar = (page: Page) => page.locator("[data-format-toolbar]");
const btn = (page: Page, label: string) =>
  bar(page).getByRole("button", { name: label, exact: true });
const run = (page: Page, id: string, tag: "em" | "strong" | "del" | "u") =>
  text(page, id).locator(tag);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await openSeededOutline(page, { anchorId: tree[0]!.id });
}

// Select the whole text of `id` by setting the DOM Selection directly (Home/End
// and arrow keys are unreliable in macOS Chromium contentEditable).
async function selectAll(page: Page, id: string) {
  await text(page, id).click();
  await text(page, id).evaluate((el) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test("hidden at a collapsed caret, the toolbar toggles bold on and off over a selection", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
  ]);
  // Collapsed caret -> no toolbar.
  await text(page, "n").click();
  await expect(bar(page)).toBeHidden();
  // Non-collapsed selection -> toolbar.
  await selectAll(page, "n");
  await expect(bar(page)).toBeVisible();

  // Toggle ON: a real `**...**` run (no browser-native <b>).
  await btn(page, "Bold").click();
  await expect(run(page, "n", "strong")).toHaveText("alphabravo");
  await expect(text(page, "n").locator("b")).toHaveCount(0);
  // The button reflects the active state, and the selection is kept.
  await expect(btn(page, "Bold")).toHaveAttribute("aria-pressed", "true");

  // Toggle OFF: the markers come back out.
  await btn(page, "Bold").click();
  await expect(run(page, "n", "strong")).toHaveCount(0);
  await expect(text(page, "n")).toHaveText("alphabravo");
});

test("highlight wraps the selection in a default-blue mark", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
  ]);
  await selectAll(page, "n");
  await btn(page, "Highlight").click();
  // The toolbar keeps the selection, so the run renders REVEALED: a blue
  // <mark> whose `==` fences are real text around the interior (ADR 0035).
  const mark = text(page, "n").locator("mark[data-highlight]");
  await expect(mark).toHaveAttribute("data-highlight", "blue");
  await expect(mark).toContainText("alphabravo");
});

test("stays hidden when a chip atom is selected (nothing to format)", async ({
  page,
}) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "See John 3:16 now",
    },
  ]);
  // Selecting the whole line -> toolbar (control: the surface works here).
  await selectAll(page, "n");
  await expect(bar(page)).toBeVisible();

  // Arrow-selecting the Bible chip wraps its contenteditable=false atom in a
  // non-collapsed range inside the span. That's not a formatting target, so the
  // toolbar must NOT appear (a native marker wrap would drop the token).
  await text(page, "n").evaluate((el) => {
    const chip = el.querySelector<HTMLElement>("[data-bible-ref]");
    const sel = window.getSelection();
    if (!chip || !sel) return;
    const range = document.createRange();
    range.selectNode(chip);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await expect(bar(page)).toBeHidden();
});

test("link opens the edit popover and creates a link", async ({ page }) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
  ]);
  await selectAll(page, "n");
  await btn(page, "Link").click();

  // The popover opens prefilled with the selected text as the label.
  const popover = page.locator("[data-link-edit-popover]");
  // Create focuses the url: the label is the selection just made (ADR 0069).
  await expect(popover.getByLabel("Link URL")).toBeFocused();
  await expect(popover).toBeVisible();
  await popover.getByLabel("Link URL").fill("https://example.com");
  await popover.getByRole("button", { name: "Done" }).click();

  // A folded <a> now carries the link; the visible label is the selection.
  const link = text(page, "n").locator("a[data-link]");
  await expect(link).toHaveAttribute(
    "data-src",
    "[alphabravo](https://example.com)",
  );
});

for (const platform of ["MacIntel", "Linux x86_64"]) {
  test(`Mod+K links selected text in rows, titles, and Quick-add, otherwise opens commands (${platform})`, async ({
    page,
  }) => {
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, "platform", { get: () => platform });
    }, platform);
    const shortcut = platform === "MacIntel" ? "Meta+k" : "Control+k";
    await load(page, [
      {
        id: "n",
        parentId: null,
        prevSiblingId: null,
        text: "Before bravo after",
      },
    ]);
    const popover = page.locator("[data-link-edit-popover]");
    const commands = page.getByPlaceholder(/Search nodes and actions/);

    for (const surface of ["row", "title", "quick-add"]) {
      if (surface === "title") await page.goto("/n");
      if (surface === "quick-add") {
        await page.evaluate(() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
        });
        await page.keyboard.press("q");
        const capture = page.getByRole("textbox", {
          name: "Quick add",
          exact: true,
        });
        await capture.fill("Before bravo after");
        await expect(capture).not.toHaveAttribute(
          "data-history-node-id",
          "__quick_add_draft__",
        );
      }
      const editor =
        surface === "row"
          ? text(page, "n")
          : surface === "title"
            ? page.locator("h2.zoomed-title .node-text")
            : page.getByRole("textbox", { name: "Quick add", exact: true });
      await editor.click();
      await editor.evaluate((el) => {
        const node = el.firstChild!;
        window.getSelection()!.setBaseAndExtent(node, 7, node, 12);
      });
      await page.keyboard.press(shortcut);
      await expect(popover.getByLabel("Link URL")).toBeFocused();
      await expect(popover.getByLabel("Link text")).toHaveValue("bravo");
      await expect(commands).toBeHidden();

      if (surface === "quick-add") {
        await page.keyboard.press("Escape");
        await expect(popover).toBeHidden();
        await expect(editor).toBeFocused();
        await expect(editor).toHaveText("Before bravo after");
        await editor.evaluate((el) => {
          const node = el.firstChild!;
          window.getSelection()!.setBaseAndExtent(node, 7, node, 12);
        });
        await page.keyboard.press(shortcut);
        await expect(popover.getByLabel("Link URL")).toBeFocused();
      }

      if (surface === "row") {
        await page.keyboard.press("Escape");
        await expect(popover).toBeHidden();
        await expect(editor).toHaveText("Before bravo after");
      } else {
        await popover.getByLabel("Link URL").fill("https://example.com/chosen");
        await page.keyboard.press("Enter");
        await expect(editor.locator("a[data-link]")).toHaveAttribute(
          "data-src",
          "[bravo](https://example.com/chosen)",
        );
        await expect(editor).toHaveText("Before bravo after");
      }

      await editor.click();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press(shortcut);
      await expect(commands).toBeVisible();
      await expect(popover).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(commands).toBeHidden();
      await expect(editor).toBeFocused();
      if (surface === "quick-add") {
        await page.keyboard.press("Enter");
        await expect(
          page.getByRole("dialog", { name: "Quick add", exact: true }),
        ).toBeHidden();
        await page.getByRole("button", { name: "Today's daily note" }).click();
        await expect(
          page.locator("li[data-node-id] a[data-link]"),
        ).toHaveAttribute("data-src", "[bravo](https://example.com/chosen)");
      }
    }
  });
}

test("link cancellation is ready immediately after autofocus", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.addEventListener("focusin", (event) => {
      const target = event.target;
      if (
        !(target instanceof HTMLInputElement) ||
        target.getAttribute("aria-label") !== "Link URL"
      )
        return;
      // Queue input before the browser advances to passive effects or timers.
      queueMicrotask(() => {
        document.documentElement.dataset.earlyEscape = "sent";
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    });
  });
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "Before bravo after",
    },
  ]);
  const editor = text(page, "n");
  await editor.click();
  await editor.evaluate((el) => {
    window
      .getSelection()!
      .setBaseAndExtent(el.firstChild!, 7, el.firstChild!, 12);
  });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("html")).toHaveAttribute(
    "data-early-escape",
    "sent",
  );
  await expect(page.locator("[data-link-edit-popover]")).toBeHidden();
  await expect(editor).toHaveText("Before bravo after");
});
