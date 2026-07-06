import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const visibleTexts = (page: Page) =>
  page.locator(".outline-row .node-text").allTextContents();

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible({ timeout: 15000 });
}

async function pasteInto(
  locator: Locator,
  data: { plain?: string; html?: string },
) {
  await locator.evaluate((el, d) => {
    const dt = new DataTransfer();
    if (d.plain) dt.setData("text/plain", d.plain);
    if (d.html) dt.setData("text/html", d.html);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, data);
}

test.describe("Markdown list paste", () => {
  test("turns pasted markdown list lines into outline bullets", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "" },
    ]);

    await text(page, "n").evaluate((el: HTMLElement) => el.focus());
    await pasteInto(text(page, "n"), {
      plain: "- Alpha\n  - Beta child\n- [x] Done\n- Gamma",
    });

    await expect(text(page, "n")).toHaveText("Alpha");
    await expect(
      page.locator('li[data-parent-id="n"] > .outline-row .node-text'),
    ).toHaveText("Beta child");

    const doneRow = page.locator("li[data-node-id] > .outline-row", {
      hasText: /^Done$/,
    });
    await expect(doneRow.locator(".checkbox")).toBeVisible();
    await expect(doneRow.locator(".node-text")).toHaveAttribute(
      "data-completed",
      "true",
    );

    expect(await visibleTexts(page)).toEqual([
      "Alpha",
      "Beta child",
      "Done",
      "Gamma",
    ]);
  });
});
