import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// A deeper-than-STANDARD tree so "Collapse all" / "Expand all" have several
// collapsible parents at more than one depth to fold:
//
//   Alpha (alpha)
//     Alpha one (alpha-1)
//       Alpha one deep (alpha-1-a)
//     Alpha two (alpha-2)
//   Bravo (bravo)
//     Bravo one (bravo-1)
//   Charlie (charlie)            <- leaf, never collapsible
const TREE: SeedNode[] = [
  { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
  { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
  { id: "charlie", parentId: null, prevSiblingId: "bravo", text: "Charlie" },
  { id: "alpha-1", parentId: "alpha", prevSiblingId: null, text: "Alpha one" },
  {
    id: "alpha-1-a",
    parentId: "alpha-1",
    prevSiblingId: null,
    text: "Alpha one deep",
  },
  { id: "alpha-2", parentId: "alpha", prevSiblingId: "alpha-1", text: "Alpha two" },
  { id: "bravo-1", parentId: "bravo", prevSiblingId: null, text: "Bravo one" },
];

// A node's OWN editable text span and its collapse chevron.
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const chevron = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .collapse-toggle`);

// Open the header "More" menu and click one of its items.
async function runMenuAction(page: Page, name: RegExp) {
  await page.getByRole("button", { name: /more/i }).click();
  await page.getByRole("menuitem", { name }).click();
}

// When zoomed, the root renders as an `h2.zoomed-title`, not an `li` row.
async function load(page: Page, path = "/", ready = text(page, "alpha")) {
  await seedOutline(page, TREE);
  await page.goto(path);
  await expect(ready).toBeVisible();
}

test.describe("Collapse all / Expand all (header More menu)", () => {
  test("Collapse all folds every nested bullet; Expand all restores them", async ({
    page,
  }) => {
    await load(page);
    // Everything starts expanded.
    await expect(text(page, "alpha-1")).toBeVisible();
    await expect(text(page, "alpha-1-a")).toBeVisible();
    await expect(text(page, "bravo-1")).toBeVisible();

    await runMenuAction(page, /Collapse all/);

    // Top-level bullets stay; all descendants are gone (instant, windowed list).
    await expect(text(page, "alpha")).toBeVisible();
    await expect(text(page, "bravo")).toBeVisible();
    await expect(text(page, "charlie")).toBeVisible();
    await expect(text(page, "alpha-1")).toBeHidden();
    await expect(text(page, "alpha-2")).toBeHidden();
    await expect(text(page, "alpha-1-a")).toBeHidden();
    await expect(text(page, "bravo-1")).toBeHidden();
    // The parents themselves now read as collapsed.
    await expect(chevron(page, "alpha")).toHaveAttribute("data-collapsed", "true");

    await runMenuAction(page, /Expand all/);

    // Every level is back, including the deepest.
    await expect(text(page, "alpha-1")).toBeVisible();
    await expect(text(page, "alpha-2")).toBeVisible();
    await expect(text(page, "alpha-1-a")).toBeVisible();
    await expect(text(page, "bravo-1")).toBeVisible();
    await expect(chevron(page, "alpha")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
  });

  test("Collapse all is scoped to the zoom root and never collapses the root", async ({
    page,
  }) => {
    // Zoom into Alpha: it renders as the page title, its children as rows.
    await load(page, "/alpha", page.locator("h2.zoomed-title .node-text"));
    await expect(text(page, "alpha-1")).toBeVisible();
    await expect(text(page, "alpha-1-a")).toBeVisible();

    await runMenuAction(page, /Collapse all/);

    // The root's DIRECT children stay visible (root not collapsed -- that would
    // hide the whole view); only their subtrees fold, so the deep node is gone.
    await expect(text(page, "alpha-1")).toBeVisible();
    await expect(text(page, "alpha-2")).toBeVisible();
    await expect(text(page, "alpha-1-a")).toBeHidden();
    // The now-childless-looking row is genuinely collapsed, not just off-screen.
    await expect(chevron(page, "alpha-1")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
  });
});
