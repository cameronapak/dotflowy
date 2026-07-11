import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Registry-driven autocomplete for the summoned `?q=` filter input (ADR 0047
// §7): empty focus shows the operator cheat sheet, `key:` shows that key's
// registered values, `#` shows the tag corpus. Selection only ever inserts text
// into the plain input; the existing debounced `?q=` write does the filtering.

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
  { id: "home", parentId: null, prevSiblingId: "ship", text: "Tidy #home" },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);
const input = (page: Page) => page.locator('[aria-label="Filter query"]');
const listbox = (page: Page) => page.locator("[data-filter-suggestions]");
const option = (page: Page, name: string | RegExp) =>
  listbox(page).getByRole("option", { name });

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(row(page, "milk").first()).toBeVisible();
}

async function summon(page: Page) {
  await page.keyboard.press("ControlOrMeta+f");
  await expect(input(page)).toBeFocused();
}

test.describe("filter autocomplete (ADR 0047 §7)", () => {
  test("empty focus shows the operator cheat sheet", async ({ page }) => {
    await load(page);
    await summon(page);

    await expect(listbox(page)).toBeVisible();
    // One row per distinct operator key (registry-driven) plus the #tag row.
    await expect(listbox(page).getByText("is:", { exact: true })).toBeVisible();
    await expect(
      listbox(page).getByText("has:", { exact: true }),
    ).toBeVisible();
    await expect(
      listbox(page).getByText("highlight:", { exact: true }),
    ).toBeVisible();
    await expect(
      listbox(page).getByText("#tag", { exact: true }),
    ).toBeVisible();
  });

  test("typing `is:` lists its values incl. todo; click inserts + filters", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("is:");
    // Values folded from every plugin sharing the `is` key (core + todos + …).
    await expect(option(page, "is:todo")).toBeVisible();
    await expect(option(page, "is:complete")).toBeVisible();

    await option(page, "is:todo").click();

    // Insertion writes the completed term (trailing space) into the input; the
    // debounced `?q=` write applies the filter.
    await expect(input(page)).toHaveValue("is:todo ");
    await expect(page).toHaveURL(/[?&]q=is/);
    await expect(row(page, "milk").first()).toBeVisible();
    await expect(row(page, "mom")).toHaveCount(0);
    await expect(row(page, "ship")).toHaveCount(0);
  });

  test("keyboard: ArrowDown highlights a row, Enter inserts it", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("is:");
    await input(page).press("ArrowDown"); // -> first row (is:todo)
    await expect(option(page, "is:todo")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await input(page).press("Enter"); // an active row -> insert (stays open)
    await expect(input(page)).toHaveValue("is:todo ");
    await expect(input(page)).toBeVisible();
  });

  test("`#` shows seeded tags; picking one filters", async ({ page }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#");
    await expect(option(page, "#home")).toBeVisible();
    await expect(option(page, "#work")).toBeVisible();

    await option(page, "#work").click();

    await expect(input(page)).toHaveValue("#work ");
    await expect(page).toHaveURL(/q=%23work/);
    await expect(row(page, "milk").first()).toBeVisible();
    await expect(row(page, "ship").first()).toBeVisible();
    await expect(row(page, "mom")).toHaveCount(0);
    await expect(row(page, "home")).toHaveCount(0);
  });

  test("`highlight:` offers the bare form + color swatches", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("highlight:");
    // The bare (any) form leads, then one swatch-painted value per color.
    await expect(option(page, "highlight:red")).toBeVisible();
    await expect(listbox(page).locator('[style*="--tag-red"]')).toBeVisible();
  });

  test("Escape closes the popover first, then the input, then the filter", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await expect(listbox(page)).toBeVisible();

    // Stage 0: popover only.
    await input(page).press("Escape");
    await expect(listbox(page)).toHaveCount(0);
    await expect(input(page)).toBeFocused();
    await expect(page).toHaveURL(/q=%23work/);

    // Stage 1: the input.
    await input(page).press("Escape");
    await expect(input(page)).toHaveCount(0);
    await expect(page).toHaveURL(/q=%23work/);

    // Stage 2: the filter.
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/q=/);
  });
});
