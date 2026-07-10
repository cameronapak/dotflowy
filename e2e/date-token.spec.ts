import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Date token (ADR 0038): a `[[YYYY-MM-DD]]` in node.text renders as a
// badge-language chip (Seam A widget, daily plugin); click travels to that
// day's note, get-or-creating it lazily (Seam B) -- rendering never mints.
// Date suggestions fold into the node-links `[[` picker (no second menu).

// Local date keys, computed the localDateKey way (never toISOString) -- the
// test process and the browser share the machine's local timezone.
function keyWithOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
const TODAY = keyWithOffset(0);
const TOMORROW = keyWithOffset(1);

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const chipIn = (page: Page, id: string) =>
  text(page, id).locator("[data-date-link]");

const TREE: SeedNode[] = [
  {
    id: "today-node",
    parentId: null,
    prevSiblingId: null,
    text: `plan [[${TODAY}]] party`,
  },
  {
    id: "tomorrow-node",
    parentId: null,
    prevSiblingId: "today-node",
    text: `standup [[${TOMORROW} 09:30]]`,
  },
  {
    id: "nearmiss",
    parentId: null,
    prevSiblingId: "tomorrow-node",
    text: "see [[2026-7-8]] maybe",
  },
  { id: "blank", parentId: null, prevSiblingId: "nearmiss", text: "" },
];

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(text(page, "today-node")).toBeVisible();
}

/** Place the caret at the end of a bullet via the Selection API (a plain click
 *  can land on a chip or past the text -- see AGENTS.md). */
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

test.describe("date token (ADR 0038)", () => {
  test("renders as a badge-language chip in the row; near-misses stay literal; no minting at render", async ({
    page,
  }) => {
    await load(page);

    // Today's chip: relative label + the sun icon (an SVG inside the widget),
    // absolute date on hover, key exposed for the click handler.
    const today = chipIn(page, "today-node");
    await expect(today).toBeVisible();
    await expect(today).toHaveAttribute("data-date-link", TODAY);
    await expect(today).toContainText("Today");
    await expect(today.locator("svg")).toHaveCount(1);

    // Time is display-only, trailing the label.
    const tomorrow = chipIn(page, "tomorrow-node");
    await expect(tomorrow).toHaveAttribute("data-date-link", TOMORROW);
    await expect(tomorrow).toContainText("Tomorrow 09:30");

    // A near-miss (`[[2026-7-8]]`) stays literal text -- no chip.
    await expect(chipIn(page, "nearmiss")).toHaveCount(0);
    await expect(text(page, "nearmiss")).toContainText("[[2026-7-8]]");

    // Rendering three chips minted NOTHING: no Daily container exists until a
    // chip is clicked (ADR 0038's no-import-time-minting rule).
    await expect(
      page.locator("li[data-node-id] > .outline-row", { hasText: "Daily" }),
    ).toHaveCount(0);
  });

  test("the chip renders in the zoomed-title path too", async ({ page }) => {
    await seedOutline(page, TREE);
    await page.goto("/today-node");

    const titleChip = page.locator("h2.zoomed-title [data-date-link]");
    await expect(titleChip).toBeVisible();
    await expect(titleChip).toContainText("Today");
  });

  test("clicking the chip creates + navigates to the day note; a second click reuses it", async ({
    page,
  }) => {
    await load(page);

    await chipIn(page, "tomorrow-node").click();

    // Zoomed into the created day note (URL left "/"); the title badge is the
    // daily plugin's own Seam-F slot keyed on the CLICKED date -- proof the
    // daily-index mapping landed on the chip's key.
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(page).not.toHaveURL(/\/$/);
    const titleBadge = page.locator(
      `h2.zoomed-title [data-daily-date="${TOMORROW}"]`,
    );
    await expect(titleBadge).toBeVisible();
    const dayUrl = page.url();

    // Back home via the breadcrumb (client nav -- keeps runtime-created nodes),
    // click again: same day note, no duplicate (get-or-create is idempotent).
    await page.locator("nav.breadcrumb button").first().click();
    await expect(page).toHaveURL(/\/$/);
    await chipIn(page, "tomorrow-node").click();
    await expect(page).toHaveURL(dayUrl);
  });

  test("typing [[tomo in the picker offers Tomorrow; picking inserts the chip", async ({
    page,
  }) => {
    await load(page);

    await text(page, "blank").click();
    await page.keyboard.type("[[tomo");

    // The date entry (label + its ISO key) -- the seeded tomorrow-node ALSO
    // matches "tomo" via its flattened label, so target the date row's
    // accessible name and assert it's PINNED above the node match.
    const option = page.getByRole("option", { name: `Tomorrow ${TOMORROW}` });
    await expect(option).toBeVisible();
    const firstOption = page
      .locator('[role="listbox"] [role="option"]')
      .first();
    await expect(firstOption).toContainText("Tomorrow");
    await expect(firstOption).toContainText(TOMORROW);

    await option.click();
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    const chip = chipIn(page, "blank");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-date-link", TOMORROW);
  });

  test("backspace deletes the whole token (an atom, not folding)", async ({
    page,
  }) => {
    await seedOutline(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: `x [[${TODAY}]]` },
    ]);
    await page.goto("/");
    await expect(chipIn(page, "n")).toBeVisible();

    await caretAtEnd(page, "n");
    await page.keyboard.press("Backspace");

    await expect(chipIn(page, "n")).toHaveCount(0);
    await expect(text(page, "n")).toHaveText("x");
  });
});
