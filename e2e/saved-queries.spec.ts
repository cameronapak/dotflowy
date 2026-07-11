import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Saved filter queries (ADR 0048): a Pin toggle inside the filter input saves
// the current `?q=` string to a synced side-collection, surfaced in the filter
// popover's "Saved" section and the Cmd+K empty state. Rename/delete live on the
// popover rows; Cmd+K only lists and runs.

const TREE: SeedNode[] = [
  {
    id: "milk",
    parentId: null,
    prevSiblingId: null,
    text: "Buy milk #work",
    isTask: true,
  },
  { id: "mom", parentId: null, prevSiblingId: "milk", text: "Call mom" },
  { id: "ship", parentId: null, prevSiblingId: "mom", text: "Ship it #work" },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);
const input = (page: Page) => page.locator('[aria-label="Filter query"]');
const popover = (page: Page) => page.locator("[data-filter-popover]");

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(row(page, "milk").first()).toBeVisible();
}

async function summon(page: Page) {
  await page.keyboard.press("ControlOrMeta+f");
  await expect(input(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
}

/** Summon, type a query, and pin it. Leaves the input focused with the query. */
async function saveWork(page: Page) {
  await summon(page);
  await input(page).fill("#work");
  await page.getByRole("button", { name: "Save filter" }).click();
  await expect(
    page.getByRole("button", { name: "Unsave filter" }),
  ).toHaveAttribute("aria-pressed", "true");
}

/** Clear the input text (keeping focus) so the empty-focus cheat sheet -- and the
 *  Saved section above it -- shows. */
async function showSavedSection(page: Page) {
  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(input(page)).toHaveValue("");
  await expect(popover(page).getByText("Saved", { exact: true })).toBeVisible();
}

test.describe("saved filter queries (ADR 0048)", () => {
  test("the pin saves the query and reflects pressed state", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    // Before saving: the pin offers to save (not pressed).
    const save = page.getByRole("button", { name: "Save filter" });
    await expect(save).toBeVisible();
    await expect(save).toHaveAttribute("aria-pressed", "false");

    await save.click();
    // After saving: the pin is pressed and now offers to unsave.
    const unsave = page.getByRole("button", { name: "Unsave filter" });
    await expect(unsave).toBeVisible();
    await expect(unsave).toHaveAttribute("aria-pressed", "true");
  });

  test("unpinning removes the saved query", async ({ page }) => {
    await load(page);
    await saveWork(page);

    // Toggle it back off.
    await page.getByRole("button", { name: "Unsave filter" }).click();
    await expect(
      page.getByRole("button", { name: "Save filter" }),
    ).toHaveAttribute("aria-pressed", "false");

    // Clear the text to reveal the empty-focus cheat sheet: with nothing saved,
    // the "Saved" section renders nothing.
    await page.getByRole("button", { name: "Clear filter" }).click();
    await expect(input(page)).toHaveValue("");
    await expect(popover(page)).toBeVisible();
    await expect(popover(page).getByText("Saved", { exact: true })).toHaveCount(
      0,
    );
  });

  test("the Saved section lists the query and clicking it applies the filter", async ({
    page,
  }) => {
    await load(page);
    await saveWork(page);
    // Clearing wipes ?q= too, so no filter is active before we click.
    await showSavedSection(page);
    await expect(page).not.toHaveURL(/q=/);

    await popover(page)
      .getByRole("button", { name: "#work", exact: true })
      .click();

    // Applied: only the two #work rows survive, and ?q= is set.
    await expect(page).toHaveURL(/q=%23work/);
    await expect(input(page)).toHaveValue("#work");
    await expect(row(page, "milk").first()).toBeVisible();
    await expect(row(page, "ship").first()).toBeVisible();
    await expect(row(page, "mom")).toHaveCount(0);
  });

  test("a saved query can be renamed inline", async ({ page }) => {
    await load(page);
    await saveWork(page);
    await showSavedSection(page);

    await popover(page).getByRole("button", { name: "Rename #work" }).click();
    const rename = popover(page).getByRole("textbox", {
      name: "Rename saved filter",
    });
    await expect(rename).toBeFocused();
    await rename.fill("My work");
    await rename.press("Enter");

    // The row now shows the custom name plus the query subtitle.
    await expect(popover(page).getByText("My work")).toBeVisible();
    await expect(
      popover(page).getByRole("button", { name: "Rename My work" }),
    ).toBeVisible();
  });

  test("a saved query can be deleted", async ({ page }) => {
    await load(page);
    await saveWork(page);
    await showSavedSection(page);

    await popover(page).getByRole("button", { name: "Delete #work" }).click();

    // The section empties, so the "Saved" heading is gone.
    await expect(popover(page).getByText("Saved", { exact: true })).toHaveCount(
      0,
    );
  });

  test("Cmd+K lists and runs a saved query", async ({ page }) => {
    await load(page);
    await saveWork(page);

    // Open the command center; the saved filter appears in the empty state.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(
      page.getByPlaceholder(/Search nodes and actions/),
    ).toBeVisible();

    await page.getByRole("option", { name: "#work", exact: true }).click();

    // Running it applies the query to the current view and closes the switcher.
    await expect(page.getByPlaceholder(/Search nodes and actions/)).toHaveCount(
      0,
    );
    await expect(page).toHaveURL(/q=%23work/);
    await expect(row(page, "milk").first()).toBeVisible();
    await expect(row(page, "mom")).toHaveCount(0);
  });
});
