import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// The summoned `?q=` filter input (ADR 0047 §6): CORE subheader chrome, opened
// by Cmd+F / the Cmd+K "Filter this view" action / tapping the pill bar. Live
// (debounced) filtering while composing; parsed-term pills when blurred with an
// active filter; two-stage Escape (close input, then clear).

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

// The active-filter bar (or the input while composing). Pill assertions scope to
// this so a `#work` PILL isn't confused with a `#work` inline chip in the outline.
const bar = (page: Page) => page.locator('[aria-label="Filter"]');

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

test.describe("summoned filter input (ADR 0047 §6)", () => {
  test("Cmd+F opens the filter input, focused", async ({ page }) => {
    await load(page);
    await summon(page);
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

  test("Enter commits and shows pills", async ({ page }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await input(page).press("Enter");

    // Input closes; the parsed term shows as a pill.
    await expect(input(page)).toHaveCount(0);
    await expect(bar(page).getByText("#work", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/q=%23work/);
  });

  test("two-stage Escape: close the input, then clear the filter", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);

    // Stage 1: Escape closes the input but keeps the active filter (pills).
    await input(page).press("Escape");
    await expect(input(page)).toHaveCount(0);
    await expect(bar(page).getByText("#work", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/q=%23work/);

    // Stage 2: a second Escape (input already gone) clears the whole filter.
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/q=/);
    await expect(page.locator('[aria-label="Filter"]')).toHaveCount(0);
  });

  test("a pill's X removes one term, keeping the others", async ({ page }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work is:todo");
    await input(page).press("Enter");

    await expect(bar(page).getByText("#work", { exact: true })).toBeVisible();
    await expect(bar(page).getByText("is:todo", { exact: true })).toBeVisible();

    await page
      .getByRole("button", { name: "Remove is:todo from filter" })
      .click();

    // Only `is:todo` is dropped; `#work` survives.
    await expect(bar(page).getByText("is:todo", { exact: true })).toHaveCount(
      0,
    );
    await expect(bar(page).getByText("#work", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/q=%23work/);
    await expect(page).not.toHaveURL(/is%3Atodo/);
  });

  test("clicking the pill bar reopens the input prefilled", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await input(page).press("Enter");
    await expect(input(page)).toHaveCount(0);

    // Tapping the pill (not its X) swaps the bar back into the input, prefilled.
    await page
      .locator('[data-tag-pill][data-tag="work"]')
      .click({ position: { x: 6, y: 8 } });

    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue("#work");
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
});
