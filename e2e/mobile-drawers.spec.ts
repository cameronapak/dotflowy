import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Include desktop scrollbar gutters in the narrow-window keyboard check.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const TARGET = "11111111-2222-3333-4444-555555555555";
const TREE: SeedNode[] = [
  { id: "tagged", parentId: null, prevSiblingId: null, text: "Ship #urgent" },
  {
    id: TARGET,
    parentId: null,
    prevSiblingId: "tagged",
    text: "Project Phoenix",
  },
  { id: "edit", parentId: null, prevSiblingId: TARGET, text: "" },
];
const editor = (page: Page) =>
  page.locator('li[data-node-id="edit"] .node-text');
const suggestions = (page: Page) => page.locator(".typing-suggestions");
const sheet = (page: Page) => page.locator(".sheet-surface");
const sheetDialog = (page: Page) =>
  page.locator('.sheet-menu-content[role="dialog"]');
const drawer = (page: Page) =>
  page.locator(".typing-suggestions, .sheet-surface");
const quickAdd = (page: Page) =>
  page.getByRole("dialog", { name: "Quick add", exact: true });

async function load(page: Page, path = "/") {
  await seedOutline(page, TREE);
  await page.goto(path);
  await expect(page.locator(".node-text").first()).toBeVisible({
    timeout: 15_000,
  });
}

async function setVisualViewport(
  page: Page,
  height: number,
  offsetTop: number,
) {
  await page.evaluate(
    ({ height, offsetTop }) => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, "height", {
        configurable: true,
        value: height,
      });
      Object.defineProperty(vv, "offsetTop", {
        configurable: true,
        value: offsetTop,
      });
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    },
    { height, offsetTop },
  );
}

async function settleSheet(page: Page) {
  await expect(page.locator(".menu-sheet-overlay")).toHaveAttribute(
    "data-expanded",
  );
  await expect
    .poll(() =>
      sheetDialog(page).evaluate((el) =>
        Math.round(el.getBoundingClientRect().bottom),
      ),
    )
    .toBe(await page.evaluate(() => innerHeight));
}

async function settleDrawer(page: Page) {
  if (await sheet(page).count()) await settleSheet(page);
  else {
    await expect(suggestions(page)).toHaveCSS("opacity", "1");
    await expect
      .poll(() =>
        suggestions(page).evaluate((el) =>
          Math.round(el.getBoundingClientRect().bottom),
        ),
      )
      .toBe(
        await page.evaluate(() =>
          Math.round(visualViewport!.height + visualViewport!.offsetTop),
        ),
      );
  }
}

async function swipeSheet(page: Page) {
  await settleSheet(page);
  const handle = await sheet(page).locator(".sheet-handle").boundingBox();
  const x = handle!.x + handle!.width / 2;
  const y = handle!.y + handle!.height / 2;
  const distance = Math.max(
    200,
    (await sheetDialog(page).boundingBox())!.height * 0.7,
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 5; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + (step * distance) / 5 }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

test.describe("narrow-screen drawers", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });

  test("document opts into safe-area viewport coverage", async ({ page }) => {
    await load(page);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /viewport-fit=cover/,
    );
  });

  test("slash keeps the caret, filters, and picks without changing surrounding text", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("Before /to");
    await expect(drawer(page)).toBeVisible();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("do");
    await expect(page.getByRole("option", { name: /To-do/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Paragraph/ })).toHaveCount(
      0,
    );
    await expect(page.locator(".typing-suggestions-viewport")).toBeVisible();
    await expect(suggestions(page)).toHaveCSS("max-height", "140px");
    await expect(
      suggestions(page).getByRole("button", { name: "Close" }),
    ).toHaveCount(0);
    await expect(suggestions(page).locator(".sheet-handle")).toHaveCount(0);
    await settleDrawer(page);
    await page.getByRole("option", { name: /To-do/ }).tap();
    await expect(drawer(page)).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    await expect(editor(page)).toHaveText("Before ");
    await expect(
      page.locator('li[data-node-id="edit"] [role="checkbox"]'),
    ).toBeVisible();
    await page.keyboard.type("after");
    await expect(editor(page)).toHaveText("Before after");
  });

  test("Escape leaves slash text untouched and short viewports shrink suggestions", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("/todo");
    await expect(drawer(page)).toBeVisible();
    await setVisualViewport(page, 180, 0);
    await expect
      .poll(() =>
        suggestions(page).evaluate((el) => el.getBoundingClientRect().height),
      )
      .toBeLessThan(140);
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("/todo");
    await expect(editor(page)).toBeFocused();
  });

  test("typing suggestions replace the toolbar, scroll options, and dismiss outside", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("/");
    await expect(drawer(page)).toBeVisible();
    await expect(page.locator("[data-mobile-bar]")).toBeHidden();
    await settleDrawer(page);
    const first = page.getByRole("option").first();
    await expect
      .poll(() =>
        first.evaluate((el) => {
          const option = el.getBoundingClientRect();
          const scroll = el
            .closest(".typing-suggestions")!
            .getBoundingClientRect();
          return option.top >= scroll.top && option.bottom <= scroll.bottom;
        }),
      )
      .toBe(true);
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    const last = page.getByRole("option").last();
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() =>
        last.evaluate((el) => {
          const option = el.getBoundingClientRect();
          const scroll = el
            .closest(".typing-suggestions")!
            .getBoundingClientRect();
          return option.top >= scroll.top && option.bottom <= scroll.bottom;
        }),
      )
      .toBe(true);
    // In both directions, an intermediate selected row stays out of the 16px
    // edge fades. First/last rows alone cannot catch dimmed keyboard selections.
    for (const keys of [["ArrowUp", "ArrowUp", "ArrowUp"], ["ArrowDown"]]) {
      for (const key of keys) await page.keyboard.press(key);
      await expect
        .poll(() =>
          page
            .locator('[role="option"][aria-selected="true"]')
            .evaluate((el) => {
              const option = el.getBoundingClientRect();
              const scroll = el
                .closest(".typing-suggestions-scroll")!
                .getBoundingClientRect();
              return (
                option.top >= scroll.top + 16 &&
                option.bottom <= scroll.bottom - 16
              );
            }),
        )
        .toBe(true);
    }
    const exitingInert = page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const observer = new MutationObserver(() => {
            const menu = document.querySelector<HTMLElement>(
              ".typing-suggestions[data-exiting]",
            );
            if (menu) {
              observer.disconnect();
              resolve(menu.inert);
            }
          });
          observer.observe(document.body, {
            attributes: true,
            subtree: true,
            attributeFilter: ["data-exiting", "inert"],
          });
        }),
    );
    await page.keyboard.press("Escape");
    expect(await exitingInert).toBe(true);
    await expect(editor(page)).toHaveText("/");
    await expect(editor(page)).toBeFocused();
    await expect(suggestions(page)).toHaveCount(0);
    await expect(page.locator("[data-mobile-bar]")).toBeVisible();
    await page.keyboard.type("t");
    await expect(suggestions(page)).toBeVisible();
    // An outside tap is allowed to move focus naturally; the dock must not
    // trap it or delete the trigger when the user leaves the edited node.
    await page.touchscreen.tap(10, 100);
    await expect(suggestions(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("/t");
  });

  test("tag and link suggestions insert into the same focused node", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("#urg");
    await expect(drawer(page)).toBeVisible();
    await expect(editor(page)).toBeFocused();
    await settleDrawer(page);
    await page.locator('[role="option"] .tag-option[data-tag="urgent"]').tap();
    await expect(editor(page).locator('.tag[data-tag="urgent"]')).toBeVisible();
    await expect(drawer(page)).toHaveCount(0);
    await page.keyboard.type(" [[Phoe");
    await expect(drawer(page)).toBeVisible();
    await expect(editor(page)).toBeFocused();
    await settleDrawer(page);
    await page.getByRole("option", { name: /Project Phoenix/ }).tap();
    await expect(
      editor(page).locator(`[data-node-link="${TARGET}"]`),
    ).toBeVisible();
    await expect(drawer(page)).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
  });

  test("a short tag sheet does not move an already visible caret or jump on dismissal", async ({
    page,
  }) => {
    const edit = TREE.find((node) => node.id === "edit");
    if (!edit) throw new Error("Drawer fixture must contain the edit node");
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `preceding-${i}`,
      parentId: null,
      prevSiblingId: i ? `preceding-${i - 1}` : TARGET,
      text: `Earlier note ${i}`,
    }));
    await seedOutline(page, [
      ...TREE.slice(0, 2),
      ...rows,
      { ...edit, prevSiblingId: "preceding-11" },
    ]);
    await page.goto("/");
    await expect(editor(page)).toBeVisible({ timeout: 15_000 });
    await editor(page).tap();
    await page.keyboard.type("Note ");
    await setVisualViewport(page, 420, 31);
    await editor(page).evaluate(() => {
      const range = window.getSelection()!.getRangeAt(0).cloneRange();
      range.collapse(false);
      window.scrollBy({
        top: range.getBoundingClientRect().bottom - 280,
        behavior: "instant",
      });
    });
    const before = await page.evaluate(() => window.scrollY);
    await page.keyboard.type("#");
    await expect(suggestions(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
    await page.keyboard.type("urg");
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(editor(page)).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await expect(editor(page)).toBeFocused();
    await expect(editor(page)).toHaveText("Note #urg");

    // Simulate a reported bottom safe area. Linux Chromium reports zero for
    // env(safe-area-inset-bottom), so supply the resulting margin explicitly.
    await page.setViewportSize({ width: 390, height: 620 });
    await setVisualViewport(page, 620, 0);
    await page.addStyleTag({
      content: ".typing-suggestions { margin-bottom: 34px !important; }",
    });
    await editor(page).evaluate(() => {
      const range = window.getSelection()!.getRangeAt(0).cloneRange();
      range.collapse(false);
      window.scrollBy({
        top: range.getBoundingClientRect().bottom - (innerHeight - 100),
        behavior: "instant",
      });
    });
    await page.keyboard.type(" /");
    await expect(suggestions(page)).toBeVisible();
    await expect
      .poll(() =>
        suggestions(page).evaluate((panel) => {
          const range = window.getSelection()!.getRangeAt(0).cloneRange();
          range.collapse(false);
          return (
            panel.getBoundingClientRect().top -
            range.getBoundingClientRect().bottom
          );
        }),
      )
      .toBeGreaterThanOrEqual(7);
    await expect(editor(page)).toBeFocused();
  });

  test("daily chrome does not cover the caret in a short keyboard viewport", async ({
    page,
  }) => {
    const edit = TREE.find((node) => node.id === "edit");
    if (!edit) throw new Error("Drawer fixture must contain the edit node");
    await seedOutline(
      page,
      [
        ...TREE.slice(0, 2),
        { ...edit, parentId: "tagged", prevSiblingId: null },
      ],
      {
        kv: {
          "daily-index": [
            {
              key: "2030-06-12",
              value: { key: "2030-06-12", nodeId: "tagged" },
            },
          ],
        },
      },
    );
    await page.goto("/tagged");
    await expect(editor(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("week-calendar-month")).toBeVisible();
    await editor(page).tap();
    await page.keyboard.type("/");
    await setVisualViewport(page, 260, 31);
    await expect(suggestions(page)).toBeVisible();
    const caretVisible = () =>
      editor(page).evaluate((el) => {
        const range = window.getSelection()!.getRangeAt(0).cloneRange();
        range.collapse(false);
        const caret = range.getBoundingClientRect();
        const bottom =
          document.querySelector(".typing-suggestions")?.getBoundingClientRect()
            .top ?? 291;
        const hit = document.elementFromPoint(
          caret.left - 1,
          (caret.top + caret.bottom) / 2,
        );
        return caret.top >= 31 && caret.bottom < bottom && el.contains(hit);
      });
    await expect.poll(caretVisible).toBe(true);
    await expect(editor(page)).toBeFocused();
    // Visibility can precede the last frames of the smooth caret reveal.
    // Measure dismissal only after that existing scroll has stopped.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const y = window.scrollY;
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve(window.scrollY === y)),
              );
            }),
        ),
      )
      .toBe(true);
    const beforeClose = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Escape");
    await expect.poll(caretVisible).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(beforeClose);
    await editor(page).evaluate((el) => el.blur());
    await expect(page.locator("div.sticky").first()).toHaveCSS(
      "position",
      "sticky",
    );
  });

  test("wrapped quick-add keeps its caret inside the clipped draft when the keyboard shrinks", async ({
    page,
  }) => {
    await load(page);
    await page.keyboard.press("q");
    const draft = page.locator(".quick-add-editor [contenteditable]");
    await expect(draft).toBeFocused();
    const text =
      "A long capture with enough words to wrap across several lines and keep the final editing position far below its first line /todo";
    await page.keyboard.type(text);
    await setVisualViewport(page, 260, 31);
    await expect(suggestions(page)).toBeVisible();
    const caretVisible = () =>
      draft.evaluate((el) => {
        const range = window.getSelection()!.getRangeAt(0).cloneRange();
        range.collapse(false);
        const caret = range.getBoundingClientRect();
        const popup = el.closest('[role="dialog"]')!.getBoundingClientRect();
        const hit = document.elementFromPoint(
          caret.left - 1,
          (caret.top + caret.bottom) / 2,
        );
        return (
          caret.top >= popup.top &&
          caret.bottom <= popup.bottom &&
          el.contains(hit)
        );
      });
    await expect.poll(caretVisible).toBe(true);
    await expect(draft).toBeFocused();
    await page.keyboard.press("Backspace");
    await page.keyboard.type("o");
    await expect.poll(caretVisible).toBe(true);
    await page.keyboard.press("Escape");
    await expect(draft).toHaveText(text);
    await expect(draft).toBeFocused();
  });

  test("More does not reopen a dismissed menu after crossing the breakpoint", async ({
    page,
  }) => {
    await load(page);
    await page.getByRole("button", { name: /More actions/ }).tap();
    await expect(drawer(page)).toBeVisible();
    await page.setViewportSize({ width: 900, height: 844 });
    await expect(drawer(page)).toHaveCount(0);
    const menu = page.locator('[data-slot="dropdown-menu-content"]');
    // Either dismiss on transition or carry the open state into the desktop menu.
    if (!(await menu.isVisible()))
      await page.getByRole("button", { name: /More actions/ }).click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("button", { name: /More actions/ }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(drawer(page)).toHaveCount(0);
  });

  test("zoomed title uses a drawer and Escape preserves the typed trigger", async ({
    page,
  }) => {
    await load(page, "/edit");
    const title = page.locator(".zoomed-title .node-text");
    await title.tap();
    await page.keyboard.type("/paragraph");
    await expect(drawer(page)).toBeVisible();
    await expect(title).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    await expect(title).toHaveText("/paragraph");
  });

  test("header toggles stay open, one-shot actions close, and wider screens keep menus", async ({
    page,
  }) => {
    await load(page);
    await page.getByRole("button", { name: /More actions/ }).tap();
    await expect(drawer(page)).toBeVisible();
    await settleSheet(page);
    const completed = page.getByRole("menuitemcheckbox", {
      name: "Show completed",
    });
    const previous = await completed.getAttribute("aria-checked");
    await completed.tap();
    await expect(completed).toHaveAttribute(
      "aria-checked",
      previous === "true" ? "false" : "true",
    );
    await expect(drawer(page)).toBeVisible();
    await expect(sheetDialog(page)).toBeVisible();
    await expect(sheet(page).locator(".sheet-handle")).toBeVisible();
    await expect(page.locator(".menu-sheet-overlay")).toBeVisible();
    await expect(page.locator(".menu-sheet-backdrop")).toBeVisible();
    await settleSheet(page);
    await page.getByRole("menuitem", { name: "Collapse all" }).tap();
    await expect(drawer(page)).toBeHidden();
    await page.setViewportSize({ width: 768, height: 844 });
    await page.getByRole("button", { name: /More actions/ }).click();
    await expect(
      page.locator('[data-slot="dropdown-menu-content"]'),
    ).toBeVisible();
    await expect(drawer(page)).toHaveCount(0);
  });

  test("quick-add child drawers dismiss independently and destination search picks a target", async ({
    page,
  }) => {
    await seedOutline(page, [
      ...TREE,
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `later-${i}`,
        parentId: null,
        prevSiblingId: i ? `later-${i - 1}` : "edit",
        text: `Later note ${i}`,
      })),
    ]);
    await page.goto("/");
    await expect(editor(page)).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() =>
      window.scrollTo({ top: 400, behavior: "instant" }),
    );
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(400);
    await page.keyboard.press("q");
    await expect(quickAdd(page)).toBeVisible();
    const draft = page.locator(".quick-add-editor [contenteditable]");
    await draft.tap();
    await page.keyboard.type("Capture /todo");
    await expect(drawer(page)).toBeVisible();
    await expect(draft).toBeFocused();
    await settleDrawer(page);
    const draftBox = (await draft.boundingBox())!;
    const suggestionsBox = (await suggestions(page).boundingBox())!;
    expect(draftBox.y + draftBox.height).toBeLessThan(suggestionsBox.y);
    await setVisualViewport(page, 260, 31);
    await expect(suggestions(page)).toBeVisible();
    await expect
      .poll(async () => {
        const text = (await draft.boundingBox())!;
        const menu = (await suggestions(page).boundingBox())!;
        return text.y >= 31 && text.y + text.height < menu.y;
      })
      .toBe(true);
    await expect(draft).toBeFocused();
    await setVisualViewport(page, 844, 0);
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    await expect(quickAdd(page)).toBeVisible();
    await expect(draft).toHaveText("Capture /todo");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("o");
    await expect(drawer(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    await expect(quickAdd(page)).toBeVisible();
    await expect(draft).toHaveText("Capture /todo");
    await page.locator("[data-quick-add-dest]").tap();
    await expect(drawer(page)).toBeVisible();
    await settleSheet(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(400);
    await page.touchscreen.tap(10, 100);
    await expect(drawer(page)).toBeHidden();
    await expect(quickAdd(page)).toBeVisible();
    await page.locator("[data-quick-add-dest]").tap();
    await expect(drawer(page)).toBeVisible();
    await drawer(page).getByPlaceholder("Capture into…").fill("Phoenix");
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeHidden();
    await expect(quickAdd(page)).toBeVisible();
    await expect(draft).toHaveText("Capture /todo");
    await expect(page.locator("[data-quick-add-dest]")).toHaveAttribute(
      "data-quick-add-dest",
      "Today",
    );
    await page.locator("[data-quick-add-dest]").tap();
    await expect(drawer(page)).toBeVisible();
    await swipeSheet(page);
    await expect(drawer(page)).toBeHidden();
    await expect(quickAdd(page)).toBeVisible();
    await expect(draft).toHaveText("Capture /todo");
    await expect(page.locator("[data-quick-add-dest]")).toHaveAttribute(
      "data-quick-add-dest",
      "Today",
    );
    await page.locator("[data-quick-add-dest]").tap();
    await drawer(page).getByPlaceholder("Capture into…").fill("Phoenix");
    await expect(
      drawer(page).getByRole("option", { name: "Project Phoenix" }),
    ).toBeInViewport();
    await settleSheet(page);
    await setVisualViewport(page, 420, 67);
    await settleSheet(page);
    await expect(
      drawer(page).getByRole("option", { name: "Project Phoenix" }),
    ).toBeInViewport();
    await drawer(page).getByRole("option", { name: "Project Phoenix" }).tap();
    await expect(drawer(page)).toBeHidden();
    await expect(quickAdd(page)).toBeVisible();
    await expect(page.locator("[data-quick-add-dest]")).toHaveAttribute(
      "data-quick-add-dest",
      "Project Phoenix",
    );
    await expect(draft).toHaveText("Capture /todo");
    await expect(draft).toBeFocused();
    const beforeClose = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Escape");
    await expect(quickAdd(page)).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(beforeClose);
  });

  test("date suggestions use the drawer and insert a date token", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("[[2030-06-12");
    await expect(drawer(page)).toBeVisible();
    await settleDrawer(page);
    await page.getByRole("option").first().tap();
    await expect(
      editor(page).locator('[data-date-link="2030-06-12"]'),
    ).toBeVisible();
    await expect(editor(page)).toBeFocused();
  });

  test("empty results stay dismissible without editing or blurring the node", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("/not-a-command");
    await expect(drawer(page)).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(0);
    await settleDrawer(page);
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("/not-a-command");
    await expect(editor(page)).toBeFocused();
  });

  test("opening another dialog from More transfers focus without leaving a drawer", async ({
    page,
  }) => {
    await load(page);
    await page.getByRole("button", { name: /More actions/ }).tap();
    await settleSheet(page);
    await page.getByRole("menuitem", { name: /What's new/ }).tap();
    await expect(drawer(page)).toBeHidden();
    const changelog = page.getByRole("dialog", { name: "What's new" });
    await expect(changelog).toBeVisible();
    await expect
      .poll(() =>
        changelog.evaluate((el) => el.contains(document.activeElement)),
      )
      .toBe(true);
  });

  test("scrolling commands does not pick the touched option or blur the editor", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("/");
    await expect(drawer(page)).toBeVisible();
    const scroll = page.locator(".typing-suggestions-scroll");
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    // Begin on an option, not the handle: a scroll must not run that command.
    const option = page.getByRole("option").nth(1);
    await expect(option).toBeInViewport();
    const box = (await option.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - step * 18 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await expect(drawer(page)).toBeVisible();
    await expect(editor(page)).toHaveText("/");
    await expect(editor(page)).toBeFocused();
  });

  test("modal content scrolls independently, a pull can reverse, and dismissal unlocks the page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 620 });
    await seedOutline(
      page,
      Array.from({ length: 30 }, (_, i) => ({
        id: `row-${i}`,
        parentId: null,
        prevSiblingId: i ? `row-${i - 1}` : null,
        text: `Outline row ${i}`,
      })),
    );
    await page.goto("/");
    await expect(page.locator(".node-text").first()).toBeVisible({
      timeout: 15_000,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBeGreaterThan(620);
    // Observe actual painted geometry: an autofocus jump to the resting snap
    // passes click tests but must fail the smooth-entry contract.
    const entry = await page.evaluateHandle(() => {
      const positions: number[] = [];
      const deadline = performance.now() + 5000;
      const sample = () => {
        const sheet = document.querySelector(".sheet-menu-content");
        const rect = sheet?.getBoundingClientRect();
        if (rect) positions.push(rect.top);
        if (
          performance.now() < deadline &&
          (!rect || rect.bottom > innerHeight + 1)
        )
          requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return positions;
    });
    const trigger = page.getByRole("button", { name: /More actions/ });
    await trigger.tap();
    await settleSheet(page);
    expect((await entry.jsonValue()).some((top) => top > 80 && top < 560)).toBe(
      true,
    );
    await entry.dispose();
    const body = sheetDialog(page);
    const heading = body.getByRole("heading", { name: "More actions" });
    const headingY = (await heading.boundingBox())!.y;
    const box = (await body.boundingBox())!;
    await expect(body).not.toHaveCSS("mask-image", "none");
    const topMask = await body.evaluate((el) => getComputedStyle(el).maskImage);
    await settleSheet(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 90);
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(90);
    await expect(body).not.toHaveCSS("mask-image", topMask);
    const middleMask = await body.evaluate(
      (el) => getComputedStyle(el).maskImage,
    );
    await settleSheet(page);
    await page.mouse.wheel(0, 240);
    await expect
      .poll(() => body.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await settleSheet(page);
    await expect(body).not.toHaveCSS("mask-image", middleMask);
    await expect(
      body.getByRole("menuitem", { name: "Sign out" }),
    ).toBeInViewport();
    expect((await heading.boundingBox())!.y).toBeCloseTo(headingY, 0);
    await expect(
      body.getByRole("button", { name: "Close", exact: true }),
    ).toBeInViewport();
    await settleSheet(page);
    await page.mouse.wheel(0, -240);
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);

    // Start inside the content at its upper scroll boundary. Native chaining
    // should pull the sheet, not scroll the page or activate a menu item.
    const y = box.y + 60;
    const x = box.x + box.width / 2;
    const top = (await sheet(page).boundingBox())!.y;
    const pageY = await page.evaluate(() => window.scrollY);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + step * 20 }],
      });
    }
    await expect
      .poll(async () => (await sheet(page).boundingBox())!.y)
      .toBeGreaterThan(top + 50);
    await expect(page.locator(".menu-sheet-backdrop")).not.toHaveCSS(
      "opacity",
      "1",
    );
    expect(await page.evaluate(() => window.scrollY)).toBe(pageY);
    for (let step = 7; step >= 0; step--) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + step * 20 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
    await settleSheet(page);
    await expect(page.locator(".menu-sheet-backdrop")).toHaveCSS(
      "opacity",
      "1",
    );
    await swipeSheet(page);
    await expect(drawer(page)).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.documentElement).overflowY,
        ),
      )
      .not.toBe("hidden");
  });

  test("reduced motion keeps modal controls and dismissal usable", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await load(page);
    await page.getByRole("button", { name: /More actions/ }).tap();
    await settleSheet(page);
    await page.getByRole("menuitemcheckbox", { name: "Show completed" }).tap();
    await expect(drawer(page)).toBeVisible();
    await settleSheet(page);
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeHidden();
    await page.getByRole("button", { name: /More actions/ }).tap();
    await swipeSheet(page);
    await expect(drawer(page)).toBeHidden();
  });

  test("calendar drawer pages months and navigates to a chosen day", async ({
    page,
  }) => {
    await seedOutline(page, TREE, {
      kv: {
        "daily-index": [
          { key: "2030-06-12", value: { key: "2030-06-12", nodeId: "tagged" } },
          { key: "2030-07-15", value: { key: "2030-07-15", nodeId: TARGET } },
        ],
      },
    });
    await page.goto("/tagged");
    await page.getByTestId("week-calendar-month").tap();
    await expect(drawer(page)).toBeVisible();
    await settleSheet(page);
    await page.getByTestId("month-picker-next").tap();
    await expect(drawer(page)).toContainText("July 2030");
    await settleSheet(page);
    const day = drawer(page).locator('[data-day-key="2030-07-15"]');
    expect((await day.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await day.tap();
    // A day page is a Day stream: the pick scrolls there (ADR 0070).
    await expect(page).toHaveURL(/\/tagged\?day=2030-07-15$/);
    await expect(drawer(page)).toBeHidden();
  });
});

test("767px uses drawers even with a mouse; 768px uses caret menus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 767, height: 800 });
  await load(page);
  await editor(page).click();
  await page.keyboard.type("/");
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 768, height: 800 });
  await page.keyboard.type("t");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
});

test("keyboard opening More focuses its first item and supports immediate arrows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 620 });
  await seedOutline(
    page,
    Array.from({ length: 30 }, (_, i) => ({
      id: `row-${i}`,
      parentId: null,
      prevSiblingId: i ? `row-${i - 1}` : null,
      text: `Outline row ${i}`,
    })),
  );
  await page.goto("/");
  await expect(page.locator(".node-text").first()).toBeVisible({
    timeout: 15_000,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeGreaterThan(620);
  expect(
    await page.evaluate(
      () => innerWidth - document.documentElement.clientWidth,
    ),
  ).toBeGreaterThan(0);
  const trigger = page.getByRole("button", { name: /More actions/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const items = drawer(page).locator('button[role^="menuitem"]:not(:disabled)');
  const disabled = drawer(page).locator('button[role^="menuitem"]:disabled');
  await expect(disabled).toHaveCount(2);
  await expect(disabled.first()).toHaveCSS("opacity", "0.5");
  await expect(items.first()).toBeFocused();
  await settleSheet(page);
  // The sheet keeps its 8px edge inset even with a classic page scrollbar.
  await expect
    .poll(() =>
      sheetDialog(page).evaluate((el) =>
        Math.round(el.getBoundingClientRect().right),
      ),
    )
    .toBe(382);
  await expect(sheetDialog(page)).toHaveCSS("overflow-y", "auto");
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await expect(items.last()).toBeInViewport();
  expect(
    await sheetDialog(page).evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0);
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
