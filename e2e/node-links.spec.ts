import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Node links + backlinks (ADR 0032): a `[[nodeId]]` token renders as a chip
// showing the TARGET's live text (Seam A widget), click zooms to the target
// (Seam B), `[[` opens the picker (Seam H), and the zoomed view shows a quiet
// "{n} backlinks" line opening the jump list (core chrome).

const TARGET = "11111111-2222-3333-4444-555555555555";
const REF = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const TREE: SeedNode[] = [
  { id: TARGET, parentId: null, prevSiblingId: null, text: "Project Phoenix" },
  {
    id: REF,
    parentId: null,
    prevSiblingId: TARGET,
    text: `kickoff for [[${TARGET}]]`,
  },
  { id: "blank", parentId: null, prevSiblingId: REF, text: "" },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const chipIn = (page: Page, id: string) =>
  text(page, id).locator(`[data-node-link="${TARGET}"]`);

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(text(page, TARGET)).toBeVisible();
}

/** Focus a bullet and place the caret at the end of its text via the Selection
 *  API (a plain click can land on a chip or past the text -- see AGENTS.md). */
async function caretAtEnd(page: Page, id: string) {
  await text(page, id).evaluate((el) => {
    (el as HTMLElement).focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test.describe("node links (ADR 0032)", () => {
  test("a [[id]] token renders as a chip with the target's LIVE text", async ({
    page,
  }) => {
    await load(page);

    const chip = chipIn(page, REF);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Project Phoenix");

    // Rename the target: every chip updates -- the label is the target's text
    // read live, not a snapshot (the id-in-source model, ADR 0032).
    await caretAtEnd(page, TARGET);
    await page.keyboard.type(" v2");
    await expect(chip).toContainText("Project Phoenix v2");
  });

  test("hand-typed junk between double brackets stays literal text", async ({
    page,
  }) => {
    await seedOutline(page, [
      {
        id: "a",
        parentId: null,
        prevSiblingId: null,
        text: "see [[not an id]] here",
      },
    ]);
    await page.goto("/");

    await expect(text(page, "a")).toContainText("[[not an id]]");
    await expect(text(page, "a").locator("[data-node-link]")).toHaveCount(0);
  });

  test("clicking the chip zooms to the target", async ({ page }) => {
    await load(page);

    await chipIn(page, REF).click();
    await expect(page).toHaveURL(new RegExp(TARGET));
    await expect(page.locator(".zoomed-title")).toContainText(
      "Project Phoenix",
    );
  });

  test("typing [[ opens the picker; picking inserts the chip", async ({
    page,
  }) => {
    await load(page);

    await text(page, "blank").click();
    await page.keyboard.type("[[Phoe");

    // The picker lists the matching node (REF's label resolves its nested link
    // to an ellipsis, so only the target itself matches "Phoe").
    const option = page
      .locator('[role="listbox"]')
      .getByText("Project Phoenix");
    await expect(option).toBeVisible();

    await option.click();
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    await expect(chipIn(page, "blank")).toBeVisible();
  });

  test("a query with no matching node keeps the menu closed", async ({
    page,
  }) => {
    await load(page);

    await text(page, "blank").click();
    await page.keyboard.type("[[zzzznope");

    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
  });
});

test.describe("backlinks (ADR 0032)", () => {
  test("the zoomed target shows a backlink count; the list jumps to the referrer", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await page.goto(`/${TARGET}`);
    await expect(page.locator(".zoomed-title")).toContainText(
      "Project Phoenix",
    );

    // The quiet line under the title -- deduped by referring node, so one
    // referrer = "1 backlink".
    const line = page.getByRole("button", { name: /1 backlink/ });
    await expect(line).toBeVisible();

    await line.click();
    const dialog = page.getByRole("dialog");
    // The referrer's text, with the link flattened to the target's label.
    await expect(dialog).toContainText("kickoff for Project Phoenix");

    // Jumping shows the referring bullet in context (its parent view -- Home
    // for a top-level referrer).
    await dialog.getByText("kickoff for").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(text(page, REF)).toBeVisible();
  });

  test("a node nothing links to renders no backlink chrome", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    // REF has a link IN its text but nothing links TO it.
    await page.goto(`/${REF}`);
    await expect(page.locator(".zoomed-title")).toBeVisible();

    await expect(
      page.getByRole("button", { name: /backlink/ }),
    ).toHaveCount(0);
  });
});
