import { test, expect } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// An 8-deep chain of long-titled nodes makes the mobile trail collapse.
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
  // A leaf has an empty list. Wait for its title while the lazy editor loads.
  await page.locator(".zoomed-title .node-text").waitFor({ state: "visible" });

  const nav = page.locator("nav.breadcrumb");
  await expect(nav).toBeVisible();

  // Home is always present (first button in the trail).
  await expect(nav.locator("button").first()).toBeVisible();

  // Exactly one crumb link, and it's the direct parent (Level 6).
  const crumbs = nav.locator(".crumb-link");
  await expect(crumbs).toHaveCount(1);
  await expect(crumbs.first()).toContainText("Level 6");

  // The compact form fits without horizontal overflow (no scroll needed).
  await expect
    .poll(() => nav.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    .toBe(true);

  // The "…" holds every ancestor between Home and the parent (n0..n5 = 6).
  const trigger = page.getByRole("button", { name: "Show hidden breadcrumbs" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const items = page.getByRole("menuitem");
  await expect(items).toHaveCount(6);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(items).toHaveCount(6);

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
  await items.nth(2).click(); // n2
  await expect(page).toHaveURL(/\/n2$/);
});
