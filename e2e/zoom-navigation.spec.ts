import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

const TREE: SeedNode[] = [
  { id: "other", parentId: null, prevSiblingId: null, text: "Other project" },
  {
    id: "other-child",
    parentId: "other",
    prevSiblingId: null,
    text: "Keep visible",
  },
  {
    id: "projects",
    parentId: null,
    prevSiblingId: "other",
    text: "Projects",
    collapsed: true,
  },
  {
    id: "dotflowy",
    parentId: "projects",
    prevSiblingId: null,
    text: "Dotflowy",
    collapsed: true,
  },
  {
    id: "ideas",
    parentId: "dotflowy",
    prevSiblingId: null,
    text: "Ideas",
    collapsed: true,
  },
  {
    id: "idea-one",
    parentId: "ideas",
    prevSiblingId: null,
    text: "First idea",
  },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const chevron = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .collapse-toggle`);
const home = (page: Page) => page.locator("nav.breadcrumb button").first();

test("Home preserves collapsed ancestors and leaves unrelated expanded nodes open", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/ideas");
  // A zoom root shows its contents even when its saved row is collapsed.
  await expect(text(page, "idea-one")).toBeVisible({ timeout: 15_000 });

  await home(page).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(chevron(page, "projects")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(text(page, "dotflowy")).toHaveCount(0);
  await expect(text(page, "other-child")).toBeVisible();

  await page.reload();
  await text(page, "other-child").waitFor();
  await expect(chevron(page, "projects")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(text(page, "dotflowy")).toHaveCount(0);
});

test("zoom-out focuses the closest visible ancestor without opening it", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/ideas");
  await expect(text(page, "idea-one")).toBeVisible({ timeout: 15_000 });

  await page
    .locator("nav.breadcrumb")
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await expect(text(page, "dotflowy")).toBeFocused();
  await expect(chevron(page, "dotflowy")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(text(page, "ideas")).toHaveCount(0);

  await home(page).click();
  await expect(text(page, "projects")).toBeFocused();
  await expect(chevron(page, "projects")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
});

for (const collapsed of [false, true]) {
  test(`Home scrolls to and focuses the off-screen ${collapsed ? "collapsed ancestor" : "node you left"}`, async ({
    page,
  }) => {
    const preceding: SeedNode[] = Array.from({ length: 120 }, (_, i) => ({
      id: `before-${i}`,
      parentId: null,
      prevSiblingId: i === 0 ? null : `before-${i - 1}`,
      text: `Earlier node ${i}`,
    }));
    await seedOutline(page, [
      ...preceding,
      ...TREE.map((node) => ({
        ...node,
        prevSiblingId: node.id === "other" ? "before-119" : node.prevSiblingId,
        collapsed: node.collapsed ? collapsed : false,
      })),
    ]);
    await page.goto("/ideas");
    await expect(text(page, "idea-one")).toBeVisible({ timeout: 15_000 });

    await home(page).click();
    const target = collapsed ? "projects" : "ideas";
    await expect(text(page, target)).toBeFocused();
    await expect(text(page, target)).toBeInViewport();
    await expect(chevron(page, "projects")).toHaveAttribute(
      "data-collapsed",
      String(collapsed),
    );
    if (collapsed) await expect(text(page, "dotflowy")).toHaveCount(0);
  });
}

for (const [count, width] of [
  [6, 997],
  [120, 997],
  [120, 390],
] as const) {
  test(`zoom-out reveals the return node before the morph with ${count} preceding rows at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 531 });
    const preceding: SeedNode[] = Array.from({ length: count }, (_, i) => ({
      id: `before-${i}`,
      parentId: null,
      prevSiblingId: i === 0 ? null : `before-${i - 1}`,
      text: `Earlier node ${i}: planning and reference notes for this project`,
    }));
    await seedOutline(page, [
      ...preceding,
      {
        id: "destination",
        parentId: null,
        prevSiblingId: `before-${count - 1}`,
        text: "Return here",
      },
      {
        id: "child",
        parentId: "destination",
        prevSiblingId: null,
        text: "Inside the node",
      },
    ]);
    await page.goto("/destination");
    await expect(text(page, "child")).toBeVisible({ timeout: 15_000 });

    // Observe the real browser transition, not a fake animation. Its ready promise
    // resolves once the incoming snapshot is captured, before the morph plays.
    await page.evaluate(() => {
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (options) => {
        const transition = start(options);
        transition.ready.then(() => {
          const row = document.querySelector(
            'li[data-node-id="destination"] .node-text',
          );
          const scroller = document.querySelector(".outline-scroll");
          const rect = row?.getBoundingClientRect();
          const viewport = scroller?.getBoundingClientRect();
          document.documentElement.dataset.zoomLanding = String(
            !!rect &&
              !!viewport &&
              rect.top >= viewport.top &&
              rect.top <= viewport.top + viewport.height * 0.4 &&
              rect.bottom <= viewport.bottom,
          );
        });
        return transition;
      };
    });
    await (
      width < 768
        ? page.getByRole("button", { name: "Back to Home", exact: true })
        : home(page)
    ).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-zoom-landing",
      "true",
    );
    await expect(text(page, "destination")).toBeFocused();
    await expect(text(page, "destination")).toBeInViewport();

    await page
      .locator('li[data-node-id="destination"] > .outline-row')
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    await expect(page).toHaveURL(/\/destination$/);
    await expect(text(page, "child")).toBeFocused();
    await expect(text(page, "child")).toBeInViewport();
    await page.evaluate(() => {
      delete document.documentElement.dataset.zoomLanding;
    });
    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.locator("html")).toHaveAttribute(
      "data-zoom-landing",
      "true",
    );
    await expect(text(page, "destination")).toBeInViewport();

    await page.goBack();
    await expect(page).toHaveURL(/\/destination$/);
    await expect(text(page, "child")).toBeInViewport();
    await page.goForward();
    await expect(page).toHaveURL(/\/$/);
    await expect(text(page, "destination")).toBeInViewport();

    // Returning through history restores where we scrolled, not the earlier
    // zoom-out landing still stored as this history entry's pivot.
    await page
      .locator(".outline-scroll")
      .evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(text(page, "before-0")).toBeInViewport();
    await page
      .locator('li[data-node-id="before-0"] > .outline-row')
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    await expect(page).toHaveURL(/\/before-0$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(text(page, "before-0")).toBeInViewport();
  });
}

test("explicit expansion and keyboard collapse persist across navigation and reload", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/dotflowy");
  await expect(text(page, "ideas")).toBeVisible({ timeout: 15_000 });
  await expect(text(page, "idea-one")).toHaveCount(0);

  // Wait for the public save response before reloading, not just the optimistic UI.
  const saved = () =>
    page.waitForResponse((response) => {
      const request = response.request();
      const path = new URL(response.url()).pathname;
      return (
        response.ok() && path === "/api/nodes" && request.method() === "PATCH"
      );
    });
  const expanded = saved();
  await chevron(page, "ideas").click();
  await expanded;
  await expect(text(page, "idea-one")).toBeVisible();

  await home(page).click();
  await expect(chevron(page, "projects")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await page.goto("/dotflowy");
  await page.locator(".zoomed-title-text").waitFor();
  await expect(text(page, "idea-one")).toBeVisible();
  await page.reload();
  await page.locator(".zoomed-title-text").waitFor();
  await expect(text(page, "idea-one")).toBeVisible();

  await text(page, "ideas").click();
  const collapsed = saved();
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await collapsed;
  await expect(text(page, "idea-one")).toHaveCount(0);
  await page.reload();
  await page.locator(".zoomed-title-text").waitFor();
  await expect(chevron(page, "ideas")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(text(page, "idea-one")).toHaveCount(0);
});

test("keyboard zoom-out preserves each saved collapse state with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedOutline(page, TREE);
  await page.goto("/ideas");
  await expect(text(page, "idea-one")).toBeVisible({ timeout: 15_000 });

  for (const [node, parent, hiddenChild] of [
    ["ideas", "dotflowy", "idea-one"],
    ["dotflowy", "projects", "ideas"],
    ["projects", "", "dotflowy"],
  ]) {
    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page).toHaveURL(new RegExp(`/${parent}$`));
    await expect(text(page, node!)).toBeFocused();
    await expect(chevron(page, node!)).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(text(page, hiddenChild!)).toHaveCount(0);
  }
});

test("a hidden mobile breadcrumb preserves collapse state and focuses the visible ancestor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await seedOutline(page, TREE);
  await page.goto("/ideas");
  await expect(text(page, "idea-one")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Show breadcrumbs" }).click();
  await expect(page.getByRole("dialog", { name: "Breadcrumbs" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Projects", exact: true }).click();
  await expect(text(page, "dotflowy")).toBeFocused();
  await expect(chevron(page, "dotflowy")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(text(page, "ideas")).toHaveCount(0);
});
