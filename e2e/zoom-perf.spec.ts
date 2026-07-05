import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Zoom performance guard.
//
// Zooming into a node remounts the whole windowed list (route key change). The
// regression we're guarding against: `@tanstack/react-hotkeys` re-registering a
// full ~20-key keymap for EVERY visible bullet on that remount burned ~130ms of
// main thread. The fix (use-bullet-keymap.ts) registers a bullet's keymap only
// while it's FOCUSED, so the manager holds ~one bullet's worth at a time, not
// `visibleRows x ~20`.
//
// We assert that bound, not a wall-clock budget. The fix is behavior-PRESERVING
// (an unfocused bullet's keymap was always a no-op -- every def is
// `target: textRef`), so the only thing distinguishing fixed from broken is
// cost. A "zoom must finish under N ms" test would measure real CPU time, which
// swings with CI hardware and flakes. Instead we read the hotkey manager's live
// registration COUNT -- the exact quantity the fix changes -- which is an
// integer in a store, identical on a MacBook and a throttled CI box. Same
// philosophy as virtualized-windowing.spec.ts: assert the structural invariant
// that yields the performance, deterministically.
//
// The count is read via `window.__hotkeyManager`, exposed DEV-only by
// src/components/hotkey-devtools.ts (stripped from production).

function perfTree(): SeedNode[] {
  const nodes: SeedNode[] = [];

  // "few": a top-level node with a handful of children.
  nodes.push({ id: "few", parentId: null, prevSiblingId: null, text: "Few" });
  let prev: string | null = null;
  for (let c = 0; c < 3; c++) {
    const id = `few-c${c}`;
    nodes.push({ id, parentId: "few", prevSiblingId: prev, text: `Few ${c}` });
    prev = id;
  }

  // "many": a top-level node with hundreds of children -- far more than any
  // viewport holds, so zooming in renders a full window of bullets.
  nodes.push({ id: "many", parentId: null, prevSiblingId: "few", text: "Many" });
  prev = null;
  for (let c = 0; c < 300; c++) {
    const id = `many-c${c}`;
    nodes.push({ id, parentId: "many", prevSiblingId: prev, text: `Many ${c}` });
    prev = id;
  }

  return nodes;
}

/** Read the singleton hotkey manager's registration count, polling until it
 *  SETTLES -- `useHotkeys` registers in a post-render effect, so the count
 *  climbs for a tick after a remount. Two equal reads in a row means the
 *  registration effects have flushed. */
async function settledRegistrationCount(page: Page): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const n = await page.evaluate(
          () =>
            (
              window as unknown as {
                __hotkeyManager?: { getRegistrationCount(): number };
              }
            ).__hotkeyManager?.getRegistrationCount() ?? -1,
        );
        const settled = n >= 0 && n === last;
        last = n;
        return settled;
      },
      { timeout: 8000, intervals: [100, 150, 200, 250] },
    )
    .toBe(true);
  return last;
}

async function load(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("dotflowy:flag:virtualized", "on"),
  );
  await seedOutline(page, perfTree());
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="few"] > .outline-row .node-text'),
  ).toBeVisible();
}

test.describe("zoom performance (focus-gated bullet keymaps)", () => {
  test("zooming into a node with hundreds of children keeps hotkey registrations bounded", async ({
    page,
  }) => {
    await load(page);

    // Zoom into the big node the way a user does: click its bullet handle.
    await page.locator('li[data-node-id="many"] [aria-label="Zoom in"]').click();
    await expect(page).toHaveURL(/\/many$/);
    await expect(page.locator('li[data-node-id="many-c0"]')).toBeVisible();

    const count = await settledRegistrationCount(page);

    // A viewport-ful of bullets is mounted (~dozens). Pre-fix each registered its
    // own ~20 hotkeys, so this was visibleRows x 20 -- 500+. Post-fix only the
    // focused bullet's keymap is live (plus a small app/zoom-title constant). A
    // generous ceiling well under the pre-fix figure catches a regression with
    // wide margin, mirroring virtualized-windowing.spec's "< 100 rows" bound.
    expect(count).toBeLessThan(120);
  });

  test("hotkey registration count does not scale with the number of visible bullets", async ({
    page,
  }) => {
    await load(page);

    // Zoom into the small node: only a few bullets render.
    await page.goto("/few");
    await expect(page.locator('li[data-node-id="few-c0"]')).toBeVisible();
    const countFew = await settledRegistrationCount(page);

    // Zoom into the huge node: a full window of bullets renders.
    await page.goto("/many");
    await expect(page.locator('li[data-node-id="many-c0"]')).toBeVisible();
    const countMany = await settledRegistrationCount(page);

    // The invariant: the manager holds ~one focused bullet's worth regardless of
    // how many bullets are on screen. The app/zoom-title hotkeys are identical in
    // both zoomed views, so they cancel; only the per-bullet term differs, and it
    // must stay near zero. Pre-fix this gap was (window - few) x ~20 = hundreds.
    expect(countMany - countFew).toBeLessThan(25);
  });
});
