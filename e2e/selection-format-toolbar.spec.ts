import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Desktop selection formatting toolbar (ADR 0036). A fine-pointer-only floating
// capsule that appears over a text selection inside one bullet/title and toggles
// bold/italic/strike/underline/highlight + create-link. It's dumb chrome over
// the same emphasis/highlight/link machinery the keyboard uses. Playwright's
// default desktop context reports `(pointer: fine)`, so the bar mounts here.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const bar = (page: Page) => page.locator("[data-format-toolbar]");
const btn = (page: Page, label: string) =>
  page.locator(`[data-format-toolbar] button[aria-label="${label}"]`);
const run = (page: Page, id: string, tag: "em" | "strong" | "del" | "u") =>
  text(page, id).locator(tag);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
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

test.describe("selection format toolbar (fine pointer)", () => {
  test("appears over a text selection, hidden with a collapsed caret", async ({
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
  });

  test("bold toggles the selection on and off", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
    ]);
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
      { id: "n", parentId: null, prevSiblingId: null, text: "See John 3:16 now" },
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
    await expect(popover).toBeVisible();
    await popover.getByLabel("Link URL").fill("https://example.com");
    await popover.getByRole("button", { name: "Done" }).click();

    // A folded <a> now carries the link; the visible label is the selection.
    const link = text(page, "n").locator("a[data-link]");
    await expect(link).toHaveAttribute("data-src", "[alphabravo](https://example.com)");
  });
});

test.describe("selection format toolbar (coarse pointer)", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 900 } });

  test("never mounts on a coarse pointer (that's the mobile bar's job)", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
    ]);
    await selectAll(page, "n");
    await expect(bar(page)).toHaveCount(0);
  });
});
