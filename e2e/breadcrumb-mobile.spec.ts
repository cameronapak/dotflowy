import { test, expect } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// An 8-deep chain of long-titled nodes: on any viewport the trail is deep enough
// to collapse, so we can assert both breadcrumb shapes off the same seed.
function deepChain(): SeedNode[] {
  const nodes: SeedNode[] = [];
  let prevParent: string | null = null;
  for (let i = 0; i < 8; i++) {
    nodes.push({
      id: `n${i}`,
      parentId: prevParent,
      prevSiblingId: null,
      text: `Level ${i} node with a fairly long descriptive title`,
    });
    prevParent = `n${i}`;
  }
  return nodes;
}

// Mobile breadcrumb: a fixed, always-fits form -- Home > … > direct parent.
// Home and the immediate parent are always visible; every ancestor between them
// lives in the portaled "…" menu. No horizontal scroll needed.
test("mobile trail is Home > … > direct parent, and the … menu holds the rest", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await seedOutline(page, deepChain());
  await page.goto("/n7"); // zoom into the leaf; parent is n6

  const nav = page.locator("nav.breadcrumb");
  await expect(nav).toBeVisible();

  // Home is always present (first button in the trail).
  await expect(nav.locator("button").first()).toBeVisible();

  // Exactly one crumb link, and it's the direct parent (Level 6).
  const crumbs = nav.locator(".crumb-link");
  await expect(crumbs).toHaveCount(1);
  await expect(crumbs.first()).toContainText("Level 6");

  // The compact form fits without horizontal overflow (no scroll needed).
  const fits = await nav.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(fits).toBe(true);

  // The "…" holds every ancestor between Home and the parent (n0..n5 = 6).
  await page.getByRole("button", { name: "Show hidden breadcrumbs" }).click();
  const items = page.getByRole("menuitem");
  await expect(items).toHaveCount(6);

  // Menu is near-full-viewport wide and labels ellipsis-truncate.
  const box = await page
    .locator('[data-slot="dropdown-menu-content"]')
    .boundingBox();
  expect(box!.width).toBeGreaterThan(300);
  const overflow = await items
    .first()
    .locator("span")
    .first()
    .evaluate((el) => getComputedStyle(el).textOverflow);
  expect(overflow).toBe("ellipsis");

  // Picking an intermediate ancestor navigates to it.
  await items.nth(2).click(); // n2
  await expect(page).toHaveURL(/\/n2$/);
});

// Desktop has room, so it keeps more context: the first ancestor + the last two,
// folding only the deep middle into "…".
test("desktop trail keeps first + last-two crumbs around the …", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedOutline(page, deepChain());
  await page.goto("/n7");

  const nav = page.locator("nav.breadcrumb");
  await expect(nav).toBeVisible();

  // lead(n0) + tail(n5, n6) = 3 visible crumbs, with the middle folded.
  await expect(nav.locator(".crumb-link")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Show hidden breadcrumbs" }),
  ).toBeVisible();
});
