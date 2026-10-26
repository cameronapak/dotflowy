import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// A node's OWN editable text span.
const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

// Enable spotlight before any app script runs, so the toggle store's first
// snapshot is already `true` and the controller installs on mount.
async function loadWithSpotlight(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.addInitScript(() => {
    window.localStorage.setItem("dotflowy:spotlight", "true");
  });
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible({ timeout: 20_000 });
}

// Alignment (issue #347): desktop keeps the #344 center; mobile (≤767) sits the
// row just below the sticky header. External scroll position only. A tall tree
// is required on mobile so max-scroll does not clamp before the row can reach
// the header (short outlines still clamp, same as desktop center).
const ALIGN_PX = 8;

function tallTree(): SeedNode[] {
  const nodes: SeedNode[] = [];
  let prev: string | null = null;
  for (let i = 0; i < 30; i++) {
    const id = `n${i}`;
    nodes.push({
      id,
      parentId: null,
      prevSiblingId: prev,
      text: `Node ${i}`,
    });
    prev = id;
  }
  return nodes;
}

async function rowAlign(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`li[data-node-id="${id}"]`);
    const header = document.querySelector("header");
    const sticky =
      header instanceof HTMLElement &&
      header.parentElement instanceof HTMLElement &&
      header.parentElement.classList.contains("sticky")
        ? header.parentElement
        : header;
    if (!el || !(sticky instanceof HTMLElement)) return null;
    const rect = el.getBoundingClientRect();
    const viewTop = window.visualViewport?.offsetTop ?? 0;
    const viewHeight = window.visualViewport?.height ?? window.innerHeight;
    return {
      topGap: rect.top - viewTop - sticky.getBoundingClientRect().height,
      centerDelta: rect.top + rect.height / 2 - (viewTop + viewHeight / 2),
    };
  }, nodeId);
}

test("focusin centers the lit row in the visual viewport", async ({ page }) => {
  await loadWithSpotlight(page);
  await text(page, "alpha-1").click();
  await expect(text(page, "alpha-1")).toBeFocused();
  await expect
    .poll(async () => {
      const align = await rowAlign(page, "alpha-1");
      return align ? Math.abs(align.centerDelta) : Infinity;
    })
    .toBeLessThan(ALIGN_PX);
});

test("a startup reinstall centers a row focused before cleanup animation ends", async ({
  page,
}) => {
  await loadWithSpotlight(page);
  const maxDelta = await text(page, "alpha-1").evaluate(async (el) => {
    const modulePath = "/src/data/spotlight.ts";
    const { uninstallSpotlight, installSpotlight } = await import(
      /* @vite-ignore */ modulePath
    );
    // Suspense can clean up and restore the controller's layout effect while
    // the saved preference stays on. Focus must work in that first frame,
    // before the cleanup's collapse tween would have finished.
    uninstallSpotlight();
    installSpotlight(false);
    el.focus({ preventScroll: true });
    // Observe the whole 200ms cleanup flight, not just the first centered frame:
    // an uncancelled tween could scroll the row away again on the next frame.
    return new Promise<number>((resolve) => {
      const start = performance.now();
      let max = 0;
      const sample = () => {
        const rect = el.closest("li")!.getBoundingClientRect();
        const center =
          (window.visualViewport?.offsetTop ?? 0) +
          (window.visualViewport?.height ?? window.innerHeight) / 2;
        max = Math.max(max, Math.abs(rect.top + rect.height / 2 - center));
        if (performance.now() - start >= 300) resolve(max);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
  await expect(text(page, "alpha-1")).toBeFocused();
  expect(maxDelta).toBeLessThan(ALIGN_PX);
});

test.describe("spotlight alignment — mobile", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test("focusin sits the lit row just below the sticky header", async ({
    page,
  }) => {
    await seedOutline(page, tallTree());
    await page.addInitScript(() => {
      window.localStorage.setItem("dotflowy:spotlight", "true");
    });
    await page.goto("/");
    await expect(text(page, "n0")).toBeVisible({ timeout: 20_000 });
    await text(page, "n4").click();
    await expect(text(page, "n4")).toBeFocused();
    await expect
      .poll(async () => {
        const align = await rowAlign(page, "n4");
        return align ? Math.abs(align.topGap) : Infinity;
      })
      .toBeLessThan(ALIGN_PX);
  });

  // Spotlight off: focusin does not scroll. Flip the same localStorage store
  // the More-menu checkbox writes so enable-breath `grow()` is the only align.
  test("enable-breath sits the lit row just below the sticky header", async ({
    page,
  }) => {
    await seedOutline(page, tallTree());
    await page.goto("/");
    await expect(text(page, "n4")).toBeVisible({ timeout: 20_000 });
    await text(page, "n4").evaluate((el) => el.focus());
    await expect(text(page, "n4")).toBeFocused();
    await expect(page.locator("body")).not.toHaveClass(/spotlight-on/);

    await page.evaluate(() => {
      window.localStorage.setItem("dotflowy:spotlight", "true");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "dotflowy:spotlight" }),
      );
    });
    await expect(page.locator("body")).toHaveClass(/spotlight-on/);
    await expect(text(page, "n4")).toBeFocused();
    await expect
      .poll(
        async () => {
          const align = await rowAlign(page, "n4");
          return align ? Math.abs(align.topGap) : Infinity;
        },
        { timeout: 15_000 },
      )
      .toBeLessThan(ALIGN_PX);
  });
});
