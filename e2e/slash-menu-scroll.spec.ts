import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE } from "./fixtures";

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

/**
 * One round-trip read of the open menu. Geometry lives here (not in locators)
 * because the invariants are COUNTABLE -- an integer scroll offset and a rect
 * containment -- which read identically on any hardware, unlike a wall clock.
 * See AGENTS.md "Perf guards: assert the countable invariant".
 */
async function menuState(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector('[role="listbox"]');
    if (!box) return null;
    const sc = box.querySelector<HTMLElement>(".overflow-y-auto")!;
    const opts = [...box.querySelectorAll('[role="option"]')];
    const idx = opts.findIndex(
      (o) => o.getAttribute("aria-selected") === "true",
    );
    const act = opts[idx]!;
    const a = act.getBoundingClientRect();
    const c = sc.getBoundingClientRect();
    return {
      count: opts.length,
      activeIndex: idx,
      activeLabel: (act as HTMLElement).innerText.split("\n")[0],
      scrollTop: sc.scrollTop,
      overflows: sc.scrollHeight > sc.clientHeight,
      activeFullyVisible: a.top >= c.top - 0.5 && a.bottom <= c.bottom + 0.5,
    };
  });
}

/** Open the `/` palette on a bullet: the "/" must follow whitespace to trigger. */
async function openSlashMenu(page: Page, id: string) {
  await text(page, id).click();
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(" /");
  await expect(page.getByRole("listbox")).toBeVisible();
}

test.describe("slash menu keyboard scrolling", () => {
  test.beforeEach(async ({ page }) => {
    await seedOutline(page, STANDARD_TREE);
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();
  });

  test("scrolls the active option into view as the highlight walks past the window", async ({
    page,
  }) => {
    await openSlashMenu(page, "bravo");

    const initial = await menuState(page);
    // Precondition: the palette must actually overflow, or this proves nothing.
    expect(initial?.overflows).toBe(true);
    expect(initial?.scrollTop).toBe(0);
    expect(initial?.activeIndex).toBe(0);

    // Walk far enough down that the highlight leaves the visible window.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");

    const after = await menuState(page);
    expect(after?.activeIndex).toBe(8);
    expect(after?.scrollTop).toBeGreaterThan(0);
    expect(after?.activeFullyVisible).toBe(true);
  });

  test("wrapping to the last option scrolls to the bottom, and back to the first returns to the top", async ({
    page,
  }) => {
    await openSlashMenu(page, "bravo");
    const { count } = (await menuState(page))!;

    // ArrowUp from the first option wraps to the last (see `wrap` in slash-menu).
    await page.keyboard.press("ArrowUp");
    const atEnd = await menuState(page);
    expect(atEnd?.activeIndex).toBe(count - 1);
    expect(atEnd?.scrollTop).toBeGreaterThan(0);
    expect(atEnd?.activeFullyVisible).toBe(true);

    // ...and wrapping forward again lands back at the top, fully scrolled back.
    await page.keyboard.press("ArrowDown");
    const atStart = await menuState(page);
    expect(atStart?.activeIndex).toBe(0);
    expect(atStart?.scrollTop).toBe(0);
    expect(atStart?.activeFullyVisible).toBe(true);
  });

  // The regression the scroll fix introduced: arrowing scrolls a NEW option
  // under a stationary cursor, and the browser fires hover events for it. With
  // `onMouseEnter` the highlight snapped back to the mouse, fighting the key.
  test("a stationary cursor never steals the highlight while arrowing", async ({
    page,
  }) => {
    await openSlashMenu(page, "bravo");

    // Park the real cursor on an option -- a genuine move, so hover DOES apply.
    const third = page.getByRole("option").nth(3);
    const box = (await third.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    expect((await menuState(page))?.activeIndex).toBe(3);

    // Now arrow away WITHOUT moving the mouse. The list scrolls beneath it.
    for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown");

    const after = await menuState(page);
    expect(after?.activeIndex).toBe(11); // the keyboard won, not the cursor
    expect(after?.scrollTop).toBeGreaterThan(0); // and the list really did scroll
    expect(after?.activeFullyVisible).toBe(true);
  });

  test("a real pointer move still selects the option under the cursor", async ({
    page,
  }) => {
    await openSlashMenu(page, "bravo");

    const second = page.getByRole("option").nth(2);
    const box = (await second.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    expect((await menuState(page))?.activeIndex).toBe(2);
  });
});
