import { expect, test, type Page } from "@playwright/test";
import { seedOutline, STANDARD_TREE } from "./fixtures";

// Coarse-pointer row redesign (ADR 0029, Workflowy-mobile parity): on touch the
// collapse chevron moves to the row's RIGHT edge and a tap on a row's dead space
// places a caret. Run in a Chromium mobile-emulation context (isMobile+hasTouch),
// which makes `@media (pointer: coarse)` / `hover: none` match -- the real media
// query users hit, not a synthetic class. The first test asserts that emulation
// actually flips the pointer type, so a silent env change fails loudly here
// rather than making the layout assertions vacuous.
test.use({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 900 } });

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);
const chevron = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .collapse-toggle`);

async function load(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible();
}

test.describe("coarse-pointer rows: right chevron + tap-to-edit", () => {
  test("mobile emulation actually reports a coarse pointer", async ({ page }) => {
    await load(page);
    const coarse = await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    );
    // If this fails, the layout assertions below would be testing the DESKTOP
    // layout by accident. Switch the suite to force the media via a class then.
    expect(coarse).toBe(true);
  });

  test("a parent row's chevron sits at the right edge, not the left gutter", async ({
    page,
  }) => {
    await load(page);
    const rowBox = await row(page, "alpha").boundingBox();
    const chevBox = await chevron(page, "alpha").boundingBox();
    expect(rowBox).not.toBeNull();
    expect(chevBox).not.toBeNull();
    // Chevron lives in the right half of the row (desktop puts it in the left
    // gutter, at a negative offset from the row's left edge).
    const chevCenter = chevBox!.x + chevBox!.width / 2;
    expect(chevCenter).toBeGreaterThan(rowBox!.x + rowBox!.width / 2);
    // ...and hugs the right edge (within the row's 4px right padding + slack).
    expect(chevBox!.x + chevBox!.width).toBeGreaterThan(
      rowBox!.x + rowBox!.width - 12,
    );
  });

  test("bullet, chevron, and text share a vertical center", async ({ page }) => {
    // Regression guard: the coarse bullet's optical-align margin lives on
    // `.outline-row .bullet`, NOT a bare `.bullet` -- a media query adds no
    // specificity, so a bare selector silently loses to the base rule and the
    // dot drops ~4px below the text (the exact bug this asserts against).
    await load(page);
    const m = await page.evaluate(() => {
      const li = document.querySelector('li[data-node-id="alpha"]')!;
      const dot = li.querySelector(".bullet-dot")!.getBoundingClientRect();
      const chev = li
        .querySelector(".collapse-toggle svg")!
        .getBoundingClientRect();
      const span = li.querySelector(".node-text")! as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(span.firstChild!);
      const line = range.getClientRects()[0];
      const center = (r: DOMRect) => r.top + r.height / 2;
      return {
        dot: center(dot),
        chev: center(chev),
        text: line.top + line.height / 2,
      };
    });
    // Dot and chevron pixel-aligned to each other, both within the optical-nudge
    // tolerance of the text's first-line center.
    expect(Math.abs(m.dot - m.chev)).toBeLessThan(1);
    expect(Math.abs(m.dot - m.text)).toBeLessThan(2.5);
    expect(Math.abs(m.chev - m.text)).toBeLessThan(2.5);
  });

  test("tapping the right chevron still collapses the subtree", async ({
    page,
  }) => {
    await load(page);
    await expect(text(page, "alpha-1")).toBeVisible();
    await chevron(page, "alpha").click();
    await expect(text(page, "alpha-1")).toBeHidden();
  });

  test("the right-edge chevron reads as an accordion: down collapsed, up expanded", async ({
    page,
  }) => {
    // On the RIGHT edge the chevron is an accordion disclosure, not a left-gutter
    // tree twisty: it points DOWN when the subtree is collapsed ("expand below")
    // and UP when expanded ("collapse"). The base glyph is a ChevronRight, so the
    // rotation is coarse-only CSS -- assert the actual rendered transform, since a
    // media query adds no specificity and a bare selector would silently no-op.
    await load(page);
    // `new DOMMatrix(transform).b` is sin(theta): +1 at rotate(90) (down), -1 at
    // rotate(-90) (up). Reading the matrix is orientation-truth, not a class check.
    const sinOf = (id: string) =>
      chevron(page, id)
        .locator("svg")
        .evaluate((svg) => new DOMMatrix(getComputedStyle(svg).transform).b);

    // alpha loads expanded (alpha-1 is visible) -> chevron points UP. Poll: the
    // rotation carries a 0.18s transition, so a bare snapshot can read mid-flip.
    await expect(text(page, "alpha-1")).toBeVisible();
    await expect.poll(() => sinOf("alpha")).toBeCloseTo(-1, 1);

    // Collapse it -> chevron flips to point DOWN.
    await chevron(page, "alpha").click();
    await expect(text(page, "alpha-1")).toBeHidden();
    await expect.poll(() => sinOf("alpha")).toBeCloseTo(1, 1);
  });

  test("tapping a row's dead space focuses the text and drops a caret", async ({
    page,
  }) => {
    await load(page);
    // bravo is childless (no chevron) and short ("Bravo"): the band to the right
    // of the text is row-body dead space. Tap it well left of the reserved right
    // padding so the tap lands on the .row-body block itself (target ===
    // currentTarget), never on the text span.
    const body = page.locator(
      `li[data-node-id="bravo"] > .outline-row .row-body`,
    );
    const box = await body.boundingBox();
    expect(box).not.toBeNull();
    await body.click({ position: { x: box!.width - 60, y: box!.height / 2 } });

    // The bullet's own text span now holds the caret.
    const focused = await text(page, "bravo").evaluate(
      (el) => el === document.activeElement,
    );
    expect(focused).toBe(true);
    // A collapsed caret sits inside that span (tap-to-edit placed it).
    const inSpan = await text(page, "bravo").evaluate((el) => {
      const sel = window.getSelection();
      return (
        !!sel &&
        sel.rangeCount > 0 &&
        sel.isCollapsed &&
        el.contains(sel.anchorNode)
      );
    });
    expect(inSpan).toBe(true);
  });
});
