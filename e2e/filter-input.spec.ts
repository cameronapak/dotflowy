import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// The `?q=` filter input (ADR 0047 §6, amended 2026-07-11): CORE subheader
// chrome opened by Cmd+F / the header magnifier / the Cmd+K "Filter this view"
// action. Live (debounced) filtering while composing; the raw query stays
// RESIDENT in the input while `?q=` is active -- focused or not (the pill state
// is dead). A trailing clear X, and a progressive Escape ladder (close the
// popover -> clear the text -> collapse the row).

const TREE: SeedNode[] = [
  {
    id: "milk",
    parentId: null,
    prevSiblingId: null,
    text: "Buy milk #work",
    isTask: true,
  },
  { id: "mom", parentId: null, prevSiblingId: "milk", text: "Call mom" },
  {
    id: "ship",
    parentId: null,
    prevSiblingId: "mom",
    text: "Ship it #work",
  },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

const input = (page: Page) => page.locator('[aria-label="Filter query"]');

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

test.describe("resident filter input (ADR 0047 §6)", () => {
  test("Cmd+F opens the filter input, focused", async ({ page }) => {
    await load(page);
    await summon(page);
  });

  test("the header magnifier opens the filter input", async ({ page }) => {
    await load(page);
    await page.getByRole("button", { name: "Filter this view" }).click();
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
  });

  test("the header magnifier toggles the filter closed", async ({ page }) => {
    await load(page);
    const magnifier = page.getByRole("button", { name: "Filter this view" });

    await magnifier.click();
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeFocused();

    // Empty summon: second press collapses the row.
    await magnifier.click();
    await expect(input(page)).toHaveCount(0);

    // With an active query: second press clears `?q=` AND collapses.
    await magnifier.click();
    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);
    await magnifier.click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(input(page)).toHaveCount(0);
  });

  test("the magnifier lights (aria-pressed) while a filter is active", async ({
    page,
  }) => {
    await load(page);
    const magnifier = page.getByRole("button", { name: "Filter this view" });

    // Idle: not pressed.
    await expect(magnifier).toHaveAttribute("aria-pressed", "false");

    // Active query lights it -- so the toggle-off press that WIPES the query
    // only fires while the button visibly reads as "on".
    await magnifier.click();
    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);
    await expect(magnifier).toHaveAttribute("aria-pressed", "true");

    // Toggle-off clears the query and drops the lit state.
    await magnifier.click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(magnifier).toHaveAttribute("aria-pressed", "false");
  });

  test("the ⌘ button opens the command center", async ({ page }) => {
    await load(page);
    await page.getByRole("button", { name: "Command center" }).click();
    await expect(
      page.getByPlaceholder(/Search nodes and actions/),
    ).toBeVisible();
    // And it is NOT the filter input.
    await expect(input(page)).toHaveCount(0);
  });

  test("the Cmd+K action opens the filter input", async ({ page }) => {
    await load(page);

    await page.keyboard.press("ControlOrMeta+k");
    await expect(
      page.getByPlaceholder(/Search nodes and actions/),
    ).toBeVisible();

    await page.getByRole("option", { name: /Filter this view/ }).click();

    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
  });

  test("typing filters the view live", async ({ page }) => {
    await load(page);
    await summon(page);

    // `is:todo` (a core operator) keeps the task, prunes the plain bullets.
    await input(page).fill("is:todo");

    await expect(row(page, "milk").first()).toBeVisible();
    await expect(row(page, "mom")).toHaveCount(0);
    await expect(row(page, "ship")).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]q=is/);
  });

  test("a free-text term filters by substring", async ({ page }) => {
    await load(page);
    await summon(page);

    await input(page).fill("milk");

    await expect(row(page, "milk").first()).toBeVisible();
    await expect(row(page, "mom")).toHaveCount(0);
    await expect(row(page, "ship")).toHaveCount(0);
  });

  test("Enter commits, blurs, and the input stays resident", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await input(page).press("Enter");

    // No pills: the input stays resident showing the raw query, but blurred.
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue("#work");
    await expect(input(page)).not.toBeFocused();
    await expect(page).toHaveURL(/q=%23work/);
  });

  test("the input stays resident on blur while a query is active", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);

    // Close the autocomplete popover (so it can't intercept the click), then
    // blur into the outline by focusing a matching bullet. The row stays open.
    await input(page).press("Escape");
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    await row(page, "milk").first().locator(".node-text").first().click();
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue("#work");
    await expect(input(page)).not.toBeFocused();
    await expect(page).toHaveURL(/q=%23work/);
  });

  test("empty text + blur collapses the row", async ({ page }) => {
    await load(page);
    await summon(page);
    await expect(input(page)).toBeVisible();

    // Close the empty-focus cheat-sheet popover, then blur with no text and no
    // active filter -> the subheader collapses away.
    await input(page).press("Escape");
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    await row(page, "mom").locator(".node-text").first().click();
    await expect(input(page)).toHaveCount(0);
  });

  test("the clear X wipes the text and the query, keeping focus", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);

    await page.getByRole("button", { name: "Clear filter" }).click();

    await expect(input(page)).toHaveValue("");
    await expect(input(page)).toBeFocused();
    await expect(page).not.toHaveURL(/q=/);
    // Cleared but still summoned -> the input stays open.
    await expect(input(page)).toBeVisible();
  });

  test("Escape ladder: close the popover, clear the text, collapse the row", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);
    // `#work` opens the tag-suggestion popover (ADR 0047 §7 autocomplete).
    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible();

    // Stage 1: Escape closes ONLY the popover; the input stays open + focused,
    // the query intact.
    await input(page).press("Escape");
    await expect(listbox).toHaveCount(0);
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(page).toHaveURL(/q=%23work/);

    // Stage 2: Escape clears the text AND the query, keeping focus.
    await input(page).press("Escape");
    await expect(input(page)).toHaveValue("");
    await expect(input(page)).toBeFocused();
    await expect(page).not.toHaveURL(/q=/);

    // Stage 3: a final Escape (empty, no popover) collapses the row.
    await input(page).press("Escape");
    await expect(input(page)).toHaveCount(0);
  });

  test("window Escape clears an active filter in one press", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await input(page).press("Enter"); // commit + blur; input stays resident
    await expect(input(page)).not.toBeFocused();
    await expect(page).toHaveURL(/q=%23work/);

    // The caret is not in the outline and no input is focused: one window-level
    // Escape clears the whole filter and collapses the row.
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/q=/);
    await expect(input(page)).toHaveCount(0);
  });
});
