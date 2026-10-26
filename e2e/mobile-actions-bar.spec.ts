import { expect, test, type Page } from "@playwright/test";

import {
  mockKeyboardViewport,
  placeCaret,
  seedOutline,
  STANDARD_TREE,
  text,
  type SeedNode,
} from "./fixtures";

// The mobile actions bar (ADR 0030) is a coarse-pointer, focus-gated toolbar. As
// in mobile-touch-rows.spec.ts, drive it in a Chromium mobile-emulation context
// so `(pointer: coarse)` actually matches -- the real signal the bar gates on,
// not a synthetic class. Geometry is tested with synthetic visualViewport
// changes. Real keyboard animation and iOS focus-preservation still require the
// manual iPhone checklist. Also covers focus/blur and each button's action wiring.

const bar = (page: Page) => page.locator("[data-mobile-bar]");
const btn = (page: Page, label: string) =>
  bar(page).getByRole("button", { name: label, exact: true });
async function load(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  // The first dev-server visit includes Vite's lazy module transforms.
  await expect(text(page, "alpha")).toBeVisible({ timeout: 15_000 });
}

// Select the whole text of `id` by setting the DOM Selection directly, as a
// long-press + handle drag would leave it.
async function selectAll(page: Page, id: string) {
  await text(page, id).click();
  await text(page, id).evaluate((el) => {
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

const ONE: SeedNode[] = [
  { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
];
async function loadOne(page: Page) {
  await seedOutline(page, ONE);
  await page.goto("/");
  await expect(text(page, "n")).toBeVisible({ timeout: 15_000 });
}

// Focus `id` and drop the caret at absolute offset `col` (copied from
// enter-split.spec.ts: Home/Arrow keys are unreliable in macOS Chromium
// contentEditable, and a plain click lands past the text).
async function caretAt(page: Page, id: string, col: number) {
  await placeCaret(text(page, id), col);
}

test.describe("mobile actions bar (coarse pointer)", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 412, height: 900 },
  });

  test.beforeEach(async ({ page }) => mockKeyboardViewport(page));

  test("keyboard dismissal hides actions even when the input retains DOM focus", async ({
    page,
  }) => {
    await load(page);
    await page.evaluate(() => {
      Object.defineProperty(visualViewport!, "height", {
        configurable: true,
        value: 900,
      });
      visualViewport!.dispatchEvent(new Event("resize"));
    });
    await text(page, "alpha").tap();
    // DOM focus before the keyboard opens (or with a hardware keyboard) is not
    // enough. A small browser-chrome change is not a keyboard either.
    await expect(text(page, "alpha")).toBeFocused();
    await expect(bar(page)).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(visualViewport!, "height", {
        configurable: true,
        value: 850,
      });
      visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(bar(page)).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(visualViewport!, "height", {
        configurable: true,
        value: 537,
      });
      visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(visualViewport!, "height", {
        configurable: true,
        value: 900,
      });
      visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(text(page, "alpha")).toBeFocused();
    await expect(bar(page)).toHaveCount(0);
    // Pinch zoom without a keyboard must not bring it back.
    await page.evaluate(() => {
      Object.defineProperties(visualViewport!, {
        height: { configurable: true, value: 450 },
        scale: { configurable: true, value: 2 },
      });
      visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(bar(page)).toHaveCount(0);
    // Reopening the keyboard on the same input has no new focusin event.
    await page.evaluate(() => {
      Object.defineProperties(visualViewport!, {
        height: { configurable: true, value: 537 },
        scale: { configurable: true, value: 1 },
      });
      visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(bar(page)).toBeVisible();
    await page.keyboard.insertText(" resumed");
    await expect(text(page, "alpha")).toContainText("resumed");
  });

  test("virtualizing away the input hides actions and refocusing restores them", async ({
    page,
  }) => {
    await seedOutline(
      page,
      Array.from({ length: 500 }, (_, i) => ({
        id: `row-${i}`,
        parentId: null,
        prevSiblingId: i ? `row-${i - 1}` : null,
        text: `Reading row ${i}`,
      })),
    );
    await page.goto("/");
    await text(page, "row-0").tap();
    await page.evaluate(() => {
      Object.defineProperty(visualViewport!, "height", {
        configurable: true,
        value: 537,
      });
      visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 20000));
    await expect(text(page, "row-0")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.activeElement === document.body),
    ).toBe(true);
    await expect(bar(page)).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await text(page, "row-0").tap();
    await expect(text(page, "row-0")).toBeFocused();
    await expect(bar(page)).toBeVisible();
    await placeCaret(text(page, "row-0"), "end");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(bar(page)).toHaveCount(0);
    await expect(page.locator('li[data-node-id="row-0"]')).toHaveAttribute(
      "data-selected",
      "single",
    );
    await page.keyboard.press("Escape");
    await expect(text(page, "row-0")).toBeFocused();
    await expect(bar(page)).toBeVisible();
  });

  test("on a coarse pointer the bar appears only while a bullet is focused", async ({
    page,
  }) => {
    await load(page);
    const coarse = await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    );
    // If this fails the visibility assertions below would test the desktop path.
    expect(coarse).toBe(true);
    // Nothing focused on load -> no bar.
    await expect(bar(page)).toHaveCount(0);
    await text(page, "alpha").click();
    await expect(bar(page)).toBeVisible();
    // Explicit blur must hide the bar even before the keyboard has resized.
    // SAFETY: text() selects the outline row's contentEditable HTML span.
    await text(page, "alpha").evaluate((el) => (el as HTMLElement).blur());
    await expect(bar(page)).toHaveCount(0);
  });

  test("fits the visible height and follows viewport panning without blocking editing", async ({
    page,
  }) => {
    await load(page);
    await text(page, "alpha").click();
    await expect(bar(page)).toBeVisible();

    // Shrink ONLY the visual viewport, as a keyboard does on current Chrome/iOS.
    // Resizing the browser window instead would miss the original failure mode.
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, "height", { configurable: true, value: 537 });
      vv.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(() => bar(page).evaluate((el) => el.getBoundingClientRect().bottom))
      .toBe(531); // 537px visible height minus the pill's existing 6px margin.

    // A scroll event changes the top edge without changing the visible height.
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, "offsetTop", {
        configurable: true,
        value: 103,
      });
      vv.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => bar(page).evaluate((el) => el.getBoundingClientRect().bottom))
      .toBe(634); // 103 + 537 - 6, not just height and not height minus offset.
    // The full-height positioning frame must not intercept taps on other nodes.
    await text(page, "alpha-2").click();
    await expect(text(page, "alpha-2")).toBeFocused();
    await btn(page, "Indent").click();
    await expect(text(page, "alpha-2")).toBeFocused();
    await expect(
      page.locator('li[data-node-id="alpha-2"][data-parent-id="alpha-1"]'),
    ).toBeVisible();

    // Closing the keyboard removes the bar even if DOM focus stays put.
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, "height", { configurable: true, value: 900 });
      Object.defineProperty(vv, "offsetTop", { configurable: true, value: 0 });
      vv.dispatchEvent(new Event("resize"));
    });
    await expect(text(page, "alpha-2")).toBeFocused();
    await expect(bar(page)).toHaveCount(0);
  });

  test("pinch zoom does not masquerade as a keyboard resize or pan", async ({
    page,
  }) => {
    await load(page);
    await text(page, "alpha").click();
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperties(vv, {
        height: { configurable: true, value: 300 },
        offsetTop: { configurable: true, value: 71 },
        scale: { configurable: true, value: 2 },
      });
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(
      await bar(page).evaluate((el) => el.getBoundingClientRect().bottom),
    ).toBe(594); // Keyboard-open frame is unchanged by pinch zoom.
  });

  test("falls back to window resizing without the Visual Viewport API", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "visualViewport", { value: null });
    });
    await load(page);
    await text(page, "alpha").click();
    await expect(bar(page)).toBeVisible();
    await page.setViewportSize({ width: 412, height: 700 });
    await expect
      .poll(() => bar(page).evaluate((el) => el.getBoundingClientRect().bottom))
      .toBe(694);
  });

  test("indent then outdent restructure the focused bullet", async ({
    page,
  }) => {
    await load(page);
    // alpha-2 has a previous sibling (alpha-1), so it can indent under it.
    await text(page, "alpha-2").click();
    await btn(page, "Indent").click();
    await expect(
      page.locator('li[data-node-id="alpha-2"][data-parent-id="alpha-1"]'),
    ).toBeVisible();

    // Outdent walks it back out to a child of alpha.
    await btn(page, "Outdent").click();
    await expect(
      page.locator('li[data-node-id="alpha-2"][data-parent-id="alpha"]'),
    ).toBeVisible();
  });

  test("undo/redo replay the last structural edit", async ({ page }) => {
    await load(page);
    await text(page, "alpha-2").click();
    await btn(page, "Indent").click();
    const indented = page.locator(
      'li[data-node-id="alpha-2"][data-parent-id="alpha-1"]',
    );
    await expect(indented).toBeVisible();

    // Undo puts it back under alpha; redo re-applies the indent.
    await btn(page, "Undo indent").click();
    await expect(indented).toHaveCount(0);
    await expect(
      page.locator('li[data-node-id="alpha-2"][data-parent-id="alpha"]'),
    ).toBeVisible();

    await btn(page, "Redo indent").click();
    await expect(indented).toBeVisible();
  });

  test("complete toggles the focused bullet's completion", async ({ page }) => {
    await load(page);
    await text(page, "alpha").click();
    await expect(text(page, "alpha")).not.toHaveAttribute(
      "data-completed",
      "true",
    );
    await btn(page, "Toggle complete").click();
    await expect(text(page, "alpha")).toHaveAttribute("data-completed", "true");
    // Toggling again un-completes it (un-mark is always allowed).
    await btn(page, "Toggle complete").click();
    await expect(text(page, "alpha")).not.toHaveAttribute(
      "data-completed",
      "true",
    );
  });

  test("the slash button inserts / and opens the command menu", async ({
    page,
  }) => {
    await load(page);
    // Caret at the START so the inserted "/" is at offset 0 and detectSlash fires
    // (it triggers only when the "/" leads the line or follows whitespace).
    await caretAt(page, "alpha", 0);
    await btn(page, "Command menu").click();
    await expect(page.locator('[role="listbox"]')).toBeVisible();
  });

  test("a text selection swaps in the format buttons; collapsing swaps back", async ({
    page,
  }) => {
    // ADR 0069: one bar, two modes, never both.
    await loadOne(page);
    await text(page, "n").click();
    await expect(btn(page, "Indent")).toBeVisible();
    await expect(btn(page, "Bold")).toHaveCount(0);

    await selectAll(page, "n");
    await expect(bar(page)).toHaveAttribute("data-mode", "format");
    for (const label of [
      "Bold",
      "Italic",
      "Strikethrough",
      "Underline",
      "Highlight",
      "Spoiler",
      "Link",
    ])
      await expect(btn(page, label)).toBeVisible();
    await expect(btn(page, "Indent")).toHaveCount(0);

    await text(page, "n").evaluate(() =>
      window.getSelection()!.collapseToEnd(),
    );
    await expect(bar(page)).toHaveAttribute("data-mode", "edit");
    await expect(btn(page, "Indent")).toBeVisible();
  });

  test("bold toggles on and off with a lit state, keeping the selection", async ({
    page,
  }) => {
    await loadOne(page);
    await selectAll(page, "n");
    await btn(page, "Bold").click();
    await expect(text(page, "n").locator("strong")).toHaveText("alphabravo");
    await expect(btn(page, "Bold")).toHaveAttribute("aria-pressed", "true");

    // The re-press is the format's undo.
    await btn(page, "Bold").click();
    await expect(text(page, "n").locator("strong")).toHaveCount(0);
    await expect(text(page, "n")).toHaveText("alphabravo");
    await expect(btn(page, "Bold")).toHaveAttribute("aria-pressed", "false");
  });

  test("a press that collapses the selection still formats what it landed on", async ({
    page,
  }) => {
    // Touch WebKit may drop a range on a tap outside it. Simulate that after
    // the bar's own pointerdown handler has run (a bubble-phase document
    // listener fires after React's root listeners), then hold the press past
    // a few frames so the live read flips before the finger lifts.
    await loadOne(page);
    await selectAll(page, "n");
    await expect(bar(page)).toHaveAttribute("data-mode", "format");
    await page.evaluate(() =>
      document.addEventListener(
        "pointerdown",
        () => window.getSelection()?.collapseToEnd(),
        { once: true },
      ),
    );
    const box = (await btn(page, "Italic").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.isCollapsed))
      .toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    // Held: the button under the finger is still Italic, not an edit action.
    await expect(bar(page)).toHaveAttribute("data-mode", "format");
    await page.mouse.up();
    await expect(text(page, "n").locator("em")).toHaveText("alphabravo");

    // Lifting outside the bar releases format mode without applying a format.
    const boldBox = (await btn(page, "Bold").boundingBox())!;
    await page.mouse.move(
      boldBox.x + boldBox.width / 2,
      boldBox.y + boldBox.height / 2,
    );
    await page.mouse.down();
    await text(page, "n").evaluate(() =>
      window.getSelection()!.collapseToEnd(),
    );
    await page.mouse.move(5, 5);
    await page.mouse.up();
    await expect(bar(page)).toHaveAttribute("data-mode", "edit");
    await expect(text(page, "n").locator("strong")).toHaveCount(0);

    // Source offsets inside a revealed token must survive the token refolding.
    await seedOutline(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "**hello** tail" },
    ]);
    await page.goto("/");
    await placeCaret(text(page, "n"), 4);
    await text(page, "n")
      .locator("strong")
      .evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
      });
    await expect(btn(page, "Bold")).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() =>
      document.addEventListener(
        "pointerdown",
        () => {
          const el = document.activeElement!;
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
        },
        { once: true },
      ),
    );
    const toggleBox = (await btn(page, "Bold").boundingBox())!;
    await page.mouse.move(
      toggleBox.x + toggleBox.width / 2,
      toggleBox.y + toggleBox.height / 2,
    );
    await page.mouse.down();
    await expect(
      text(page, "n").locator('strong[contenteditable="false"]'),
    ).toHaveCount(1);
    await page.mouse.up();
    await expect(text(page, "n")).toHaveText("hello tail");
    await expect(text(page, "n").locator("strong")).toHaveCount(0);
  });

  test("highlight toggles off and stays in format mode", async ({ page }) => {
    await loadOne(page);
    await selectAll(page, "n");
    await btn(page, "Highlight").click();
    await expect(text(page, "n").locator("mark[data-highlight]")).toHaveCount(
      1,
    );
    await expect(btn(page, "Highlight")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await btn(page, "Highlight").click();
    await expect(text(page, "n").locator("mark[data-highlight]")).toHaveCount(
      0,
    );
    await expect(bar(page)).toHaveAttribute("data-mode", "format");
    await expect(btn(page, "Highlight")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("link opens a sheet with the url focused, and creates the link", async ({
    page,
  }) => {
    await loadOne(page);
    await selectAll(page, "n");
    await btn(page, "Link").click();
    const sheet = page.locator(".sheet-surface");
    await expect(page.locator(".menu-sheet-overlay")).toHaveAttribute(
      "data-expanded",
    );
    // Wait out the entry animation before tapping inside the sheet.
    const done = sheet.getByRole("button", { name: "Done" });
    await expect
      .poll(() =>
        done.evaluate(
          (el) => el.getBoundingClientRect().bottom <= window.innerHeight,
        ),
      )
      .toBe(true);
    const url = sheet.getByLabel("Link URL");
    await expect(url).toBeFocused();
    await expect(bar(page)).toHaveCount(0);
    await url.fill("https://example.com");
    await expect(sheet.getByRole("heading")).toHaveText("Add link");
    await done.click();
    // Done animates the sheet out, then the overlay unmounts.
    await expect(sheet).toHaveCount(0);
    await expect(text(page, "n")).toBeFocused();
    await expect(bar(page)).toBeVisible();
    // The caret is back inside the new link, so it renders revealed: the label
    // as text and the url as a chip.
    await expect(text(page, "n").locator(".link-label")).toHaveText(
      "alphabravo",
    );
    await expect(
      text(page, "n").locator('.link-url-chip[data-src="https://example.com"]'),
    ).toHaveCount(1);
  });
});

test("a fine pointer never shows mobile actions, even in a narrow keyboard-sized viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 900 });
  await mockKeyboardViewport(page);
  await load(page);
  await text(page, "alpha").click();
  expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(
    true,
  );
  await expect(text(page, "alpha")).toBeFocused();
  await expect(bar(page)).toHaveCount(0);
});

// Native formatting input (ADR 0069): the iOS selection menu's Format items
// arrive as `beforeinput`. They become marker toggles; every other `format*`
// input is cancelled so the browser never injects HTML into the source.
test("native format input toggles markers and never injects HTML", async ({
  page,
}) => {
  await seedOutline(page, [
    ...ONE,
    {
      id: "other",
      parentId: null,
      prevSiblingId: "n",
      text: "untouched",
    },
  ]);
  await page.goto("/");
  await expect(text(page, "n")).toBeVisible({ timeout: 15_000 });
  const fire = (inputType: string) =>
    text(page, "n").evaluate(
      (el, type) =>
        !el.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: type,
            bubbles: true,
            cancelable: true,
          }),
        ),
      inputType,
    );

  await placeCaret(text(page, "n"), "end");
  await text(page, "n").evaluate((el) => {
    const other = document.querySelector(
      'li[data-node-id="other"] .node-text',
    )!;
    const range = document.createRange();
    range.setStart(el.firstChild!, 2);
    range.setEnd(other.firstChild!, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  expect(await fire("formatBold")).toBe(true);
  await expect(text(page, "n")).toHaveText("alphabravo");
  await expect(text(page, "other")).toHaveText("untouched");

  await placeCaret(text(page, "n"), "end");
  await page.keyboard.type("tail");
  await selectAll(page, "n");
  expect(await fire("formatBold")).toBe(true);
  await expect(text(page, "n").locator("strong")).toHaveText("alphabravotail");

  // Chromium's InputEvent constructor drops some types (formatFontColor),
  // so probe the cancel path with one it keeps.
  expect(await fire("formatSuperscript")).toBe(true);
  await expect(text(page, "n").locator("sup")).toHaveCount(0);
  await expect(text(page, "n").locator("strong")).toHaveText("alphabravotail");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(text(page, "n")).toHaveText("alphabravotail");
  await expect(text(page, "n").locator("strong")).toHaveCount(0);
});
