import { expect, test, type Page } from "@playwright/test";

import {
  applyFilter,
  filterPill,
  findInput,
  openSeededOutline,
  seedOutline,
  type SeedNode,
} from "./fixtures";

// Saved filter queries (ADR 0048, moved into Find by ADR 0089): the applied
// filter's pill pins the current `?q=` string to a synced side-collection.
// Find lists saved filters (the desktop rail's Saved section, the phone list),
// where a row fills Find, the pencil renames inline, and the X deletes.

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
const saved = (page: Page) =>
  page.getByRole("dialog", { name: "Find" }).getByRole("region", {
    name: "Saved",
  });

async function load(page: Page) {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "milk" });
}

/** Apply `#work`, pin it, then clear the filter so nothing is active. */
async function saveWork(page: Page) {
  await applyFilter(page, "#work");
  await page.getByRole("button", { name: "Save filter" }).click();
  await expect(
    page.getByRole("button", { name: "Unsave filter" }),
  ).toHaveAttribute("aria-pressed", "true");
  await applyFilter(page, "");
}

test("the pin saves and unpins the applied query", async ({ page }) => {
  await load(page);
  await applyFilter(page, "#work");
  const save = page.getByRole("button", { name: "Save filter" });
  await expect(save).toHaveAttribute("aria-pressed", "false");

  await save.click();
  const unsave = page.getByRole("button", { name: "Unsave filter" });
  await expect(unsave).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(
    saved(page).getByRole("button", { name: "#work", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await unsave.click();
  await expect(
    page.getByRole("button", { name: "Save filter" }),
  ).toHaveAttribute("aria-pressed", "false");
  // With nothing saved, Find has no Saved section.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(findInput(page)).toBeFocused();
  await expect(saved(page)).toHaveCount(0);
});

test("a Saved row fills Find, and Shift+Enter applies it", async ({ page }) => {
  await load(page);
  await saveWork(page);
  await expect(page).not.toHaveURL(/q=/);

  await page.keyboard.press("ControlOrMeta+k");
  await saved(page).getByRole("button", { name: "#work", exact: true }).click();

  // Find fills the query without changing the outline.
  await expect(findInput(page)).toHaveValue("#work");
  await expect(findInput(page)).toBeFocused();
  await expect(page).not.toHaveURL(/q=/);
  await findInput(page).press("Shift+Enter");
  await expect(page).toHaveURL(/q=%23work/);
  await expect(filterPill(page)).toContainText("#work");
  await expect(row(page, "milk").first()).toBeVisible();
  await expect(row(page, "ship").first()).toBeVisible();
  await expect(row(page, "mom")).toHaveCount(0);
});

test("a saved query can be renamed inline and deleted by its new name", async ({
  page,
}) => {
  await load(page);
  await saveWork(page);
  await page.keyboard.press("ControlOrMeta+k");

  // Escape cancels a rename without closing Find.
  await saved(page).getByRole("button", { name: "Rename #work" }).click();
  const rename = saved(page).getByRole("textbox", {
    name: "Rename saved filter",
  });
  await expect(rename).toBeFocused();
  await rename.fill("Discarded");
  await rename.press("Escape");
  await expect(findInput(page)).toBeFocused();
  await expect(
    saved(page).getByRole("button", { name: "#work", exact: true }),
  ).toBeVisible();

  // Enter commits without running the highlighted Find row.
  await saved(page).getByRole("button", { name: "Rename #work" }).click();
  await rename.fill("My work");
  await rename.press("Enter");
  await expect(findInput(page)).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Find" })).toBeVisible();
  const renamed = saved(page).getByRole("button", {
    name: "My work",
    exact: true,
  });
  await expect(renamed).toHaveAttribute("title", "#work");

  // Typing the new name finds it in the list too, where Enter runs it.
  await findInput(page).fill("My work");
  await expect(page.getByRole("option", { name: /My work/ })).toHaveAttribute(
    "data-selected",
    "true",
  );
  await findInput(page).press("Enter");
  await expect(findInput(page)).toHaveValue("#work");

  // Enter on a focused Delete deletes, rather than running the highlighted row.
  await saved(page).getByRole("button", { name: "Delete My work" }).focus();
  await page.keyboard.press("Enter");
  await expect(saved(page)).toHaveCount(0);
  await expect(findInput(page)).toBeFocused();
});
