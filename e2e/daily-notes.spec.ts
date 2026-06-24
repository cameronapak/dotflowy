import { expect, test, type Page } from "@playwright/test";
import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// Cmd on macOS, Control elsewhere.
function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

const todayButton = (page: Page) =>
  page.getByRole("button", { name: "Today's daily note" });

// A daily node's id is a generated UUID, so locate rows by their visible text.
const rowWithText = (page: Page, t: string) =>
  page.locator("li[data-node-id] > .outline-row", { hasText: t });

async function load(page: Page, tree: SeedNode[] = STANDARD_TREE) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="alpha"] > .outline-row > .node-text'),
  ).toBeVisible();
}

// The breadcrumb's leading icon button zooms back to the top. It's a CLIENT
// navigation, so the seedOutline init script does not re-run and wipe the nodes
// created at runtime (a full reload would).
async function goHome(page: Page) {
  await page.locator("nav.breadcrumb button").first().click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("daily notes", () => {
  test("Today creates the Daily container + today's note and zooms in", async ({
    page,
  }) => {
    await load(page);

    await expect(todayButton(page)).toBeVisible();
    await todayButton(page).click();

    // Zoomed into a node (URL left "/"); its title is today's full date.
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(page).not.toHaveURL(/\/$/);
    const year = String(new Date().getFullYear());
    await expect(page.locator("h2.zoomed-title .node-text")).toContainText(year);

    // Home: the protected "Daily" container holds today's note, badged "Today".
    await goHome(page);
    await expect(rowWithText(page, "Daily")).toBeVisible();
    const badge = page.locator("[data-daily-date]");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("Today");
  });

  test("clicking Today twice reuses the same note (no duplicates)", async ({
    page,
  }) => {
    await load(page);

    await todayButton(page).click();
    const firstUrl = page.url();

    await goHome(page);
    await todayButton(page).click();

    // Same note -> same URL, and still exactly one daily badge in the tree.
    await expect(page).toHaveURL(firstUrl);
    await goHome(page);
    await expect(page.locator("[data-daily-date]")).toHaveCount(1);
  });

  test("the `/` command moves a node under today's note", async ({ page }) => {
    await load(page);

    // Run the slash command from a top-level node. The leading space makes the
    // "/" follow whitespace so detectSlash fires; "/today" uniquely matches
    // "Move to Today" (see move-dialog.spec for the pattern).
    const charlie = page.locator(
      'li[data-node-id="charlie"] > .outline-row > .node-text',
    );
    await charlie.click();
    await expect(charlie).toBeFocused();
    await page.keyboard.type(" /today");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter");

    // Confirming toast, and the node -- a top-level sibling before -- now nests
    // under the Daily container's today note (creating both on first use).
    await expect(page.getByText("Moved to Today")).toBeVisible();
    const dailyContainer = page.locator("li[data-node-id]", {
      hasText: "Daily",
    });
    await expect(
      dailyContainer.locator('li[data-node-id="charlie"]'),
    ).toBeVisible();
  });

  test("the Daily container resists deletion; ordinary nodes still delete", async ({
    page,
  }) => {
    await load(page);
    await todayButton(page).click();
    await goHome(page);

    // Force-delete (Mod+Shift+Backspace) the protected container: a no-op.
    await rowWithText(page, "Daily").locator(".node-text").click();
    await page.keyboard.press(`${modifier()}+Shift+Backspace`);
    await expect(rowWithText(page, "Daily")).toBeVisible();

    // The same gesture DOES delete an ordinary node -- the guard is specific.
    await page
      .locator('li[data-node-id="bravo"] > .outline-row > .node-text')
      .click();
    await page.keyboard.press(`${modifier()}+Shift+Backspace`);
    await expect(page.locator('li[data-node-id="bravo"]')).toHaveCount(0);
  });
});
