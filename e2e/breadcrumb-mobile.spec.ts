import { test, expect } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// An 8-deep chain of long-titled nodes.
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

// Mobile breadcrumb (ADR 0076): Back to the direct parent, plus a chevron whose
// sheet lists Home and every other ancestor. The parent's name survives the
// narrowest supported width.
test("mobile Back names the parent, and the breadcrumb sheet holds Home and the rest", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await seedOutline(page, deepChain());
  await page.goto("/n7"); // zoom into the leaf; parent is n6
  // A leaf has an empty list. Wait for its title while the lazy editor loads.
  await page.locator(".zoomed-title .node-text").waitFor({ state: "visible" });

  const nav = page.getByRole("navigation", { name: "Breadcrumb" });
  const back = nav.getByRole("button", {
    name: "Back to Level 6 node with a fairly long descriptive title",
  });
  await expect(back).toBeVisible();
  await expect(back).toContainText("Lev");
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);

  // Home first, then every ancestor above the parent (n0..n5): 7 rows.
  const trigger = nav.getByRole("button", { name: "Show breadcrumbs" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const items = page.getByRole("menuitem");
  await expect(items).toHaveCount(7);
  await expect(items.first()).toHaveText("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await expect(items.last()).toContainText("Level 5");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(items).toHaveCount(7);

  // Wait for the drawer's resting snap point before Playwright scrolls the
  // target into view; scrolling during entry can dismiss the native sheet.
  await expect
    .poll(() =>
      page
        .locator(".sheet-menu-content")
        .evaluate((el) => Math.round(el.getBoundingClientRect().bottom)),
    )
    .toBe(700);

  // Picking an intermediate ancestor navigates to it.
  await items.nth(3).click(); // n2
  await expect(page).toHaveURL(/\/n2$/);

  // Back goes to the direct parent; at the top level it goes Home.
  await nav.getByRole("button", { name: /^Back to Level 1/ }).click();
  await expect(page).toHaveURL(/\/n1$/);
  await nav.getByRole("button", { name: /^Back to Level 0/ }).click();
  await expect(page).toHaveURL(/\/n0$/);
  await expect(
    nav.getByRole("button", { name: "Show breadcrumbs" }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(nav).toHaveCount(0);
});
