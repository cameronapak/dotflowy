import { expect, test, type Page } from "@playwright/test";

import { placeCaret, seedOutline, STANDARD_TREE, text } from "./fixtures";

/**
 * One round-trip read of the open menu. Geometry lives here (not in locators)
 * because the invariants are COUNTABLE -- an integer scroll offset and a rect
 * containment -- which read identically on any hardware, unlike a wall clock.
 * See CONTRIBUTING.md "A perf guard asserts a countable invariant".
 */
async function menuState(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector('[role="listbox"]');
    if (!box) return null;
    const sc = box.querySelector<HTMLElement>(".overflow-y-auto")!;
    const opts = [...box.querySelectorAll<HTMLElement>('[role="option"]')];
    const idx = opts.findIndex(
      (o) => o.getAttribute("aria-selected") === "true",
    );
    const act = opts[idx]!;
    const a = act.getBoundingClientRect();
    const c = sc.getBoundingClientRect();
    return {
      count: opts.length,
      activeIndex: idx,
      activeLabel: act.innerText.split("\n")[0],
      scrollTop: sc.scrollTop,
      overflows: sc.scrollHeight > sc.clientHeight,
      activeFullyVisible: a.top >= c.top - 0.5 && a.bottom <= c.bottom + 0.5,
    };
  });
}

type MenuState = NonNullable<Awaited<ReturnType<typeof menuState>>>;

/** A poll target for one field of the open menu, for `expect.poll`. */
const menuField =
  <K extends keyof MenuState>(page: Page, key: K) =>
  async () =>
    (await menuState(page))?.[key];

async function openOutline(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible();
}

/** Open the `/` palette on a bullet: the "/" must follow whitespace to trigger. */
async function openSlashMenu(page: Page, id: string) {
  await placeCaret(text(page, id), "end");
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(" /");
  await expect(page.getByRole("listbox")).toBeVisible();
}

test("scrolls the active option into view as the highlight walks past the window", async ({
  page,
}) => {
  await openOutline(page);
  await openSlashMenu(page, "bravo");

  // Precondition: the palette must actually overflow, or this proves nothing.
  await expect.poll(menuField(page, "overflows")).toBe(true);
  await expect.poll(menuField(page, "scrollTop")).toBe(0);
  await expect.poll(menuField(page, "activeIndex")).toBe(0);

  // Walk far enough down that the highlight leaves the visible window.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");

  await expect.poll(menuField(page, "activeIndex")).toBe(8);
  await expect.poll(menuField(page, "scrollTop")).toBeGreaterThan(0);
  await expect.poll(menuField(page, "activeFullyVisible")).toBe(true);
});

test("wrapping to the last option scrolls to the bottom, and back to the first returns to the top", async ({
  page,
}) => {
  await openOutline(page);
  await openSlashMenu(page, "bravo");
  const { count } = (await menuState(page))!;

  // ArrowUp from the first option wraps to the last (see `wrap` in slash-menu).
  await page.keyboard.press("ArrowUp");
  await expect.poll(menuField(page, "activeIndex")).toBe(count - 1);
  await expect.poll(menuField(page, "scrollTop")).toBeGreaterThan(0);
  await expect.poll(menuField(page, "activeFullyVisible")).toBe(true);

  // ...and wrapping forward again lands back at the top, fully scrolled back.
  await page.keyboard.press("ArrowDown");
  await expect.poll(menuField(page, "activeIndex")).toBe(0);
  await expect.poll(menuField(page, "scrollTop")).toBe(0);
  await expect.poll(menuField(page, "activeFullyVisible")).toBe(true);
});

// The regression the scroll fix introduced: arrowing scrolls a NEW option
// under a stationary cursor, and the browser fires hover events for it. With
// `onMouseEnter` the highlight snapped back to the mouse, fighting the key.
test("a stationary cursor never steals the highlight while arrowing", async ({
  page,
}) => {
  await openOutline(page);
  await openSlashMenu(page, "bravo");

  // Park the real cursor on an option -- a genuine move, so hover DOES apply.
  const third = page.getByRole("option").nth(3);
  const box = (await third.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(menuField(page, "activeIndex")).toBe(3);

  // Now arrow away WITHOUT moving the mouse. The list scrolls beneath it.
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown");

  await expect.poll(menuField(page, "activeIndex")).toBe(11); // the keyboard won, not the cursor
  await expect.poll(menuField(page, "scrollTop")).toBeGreaterThan(0); // and the list really did scroll
  await expect.poll(menuField(page, "activeFullyVisible")).toBe(true);
});

test("a real pointer move still selects the option under the cursor", async ({
  page,
}) => {
  await openOutline(page);
  await openSlashMenu(page, "bravo");

  const second = page.getByRole("option").nth(2);
  const box = (await second.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  await expect.poll(menuField(page, "activeIndex")).toBe(2);
});
