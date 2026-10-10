import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

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
const drawer = (page: Page) => page.locator('[data-slot="drawer-popup"]');
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

async function settleDrawer(page: Page) {
  await expect
    .poll(() =>
      drawer(page).evaluate((el) =>
        Math.round(el.getBoundingClientRect().bottom),
      ),
    )
    .toBe(
      await page.evaluate(() =>
        Math.round(
          window.visualViewport!.height + window.visualViewport!.offsetTop,
        ),
      ),
    );
}

async function swipeDrawer(page: Page) {
  await settleDrawer(page);
  const handle = await drawer(page)
    .locator('[data-slot="drawer-swipe-handle"]')
    .boundingBox();
  const x = handle!.x + handle!.width / 2;
  const y = handle!.y + handle!.height / 2;
  const distance = Math.max(
    200,
    (await drawer(page).boundingBox())!.height * 0.7,
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

  test("close leaves slash text untouched and follows keyboard resize and panning", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("/todo");
    await expect(drawer(page)).toBeVisible();
    await setVisualViewport(page, 420, 67);
    await expect
      .poll(() =>
        drawer(page).evaluate((el) =>
          Math.round(el.getBoundingClientRect().bottom),
        ),
      )
      .toBe(487);
    await expect
      .poll(() =>
        drawer(page).evaluate((el) => el.getBoundingClientRect().height),
      )
      .toBeLessThanOrEqual(210);
    await drawer(page)
      .getByRole("button", { name: "Close", exact: true })
      .tap();
    await expect(drawer(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("/todo");
    await expect(editor(page)).toBeFocused();
  });

  test("a short keyboard viewport leaves a whole command reachable", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("/");
    await expect(drawer(page)).toBeVisible();
    await setVisualViewport(page, 260, 31);
    await settleDrawer(page);
    await expect
      .poll(() => page.locator('[data-slot="drawer-viewport"]').boundingBox())
      .toEqual({ x: 0, y: 31, width: 390, height: 260 });
    await expect
      .poll(async () => {
        const text = (await editor(page).boundingBox())!;
        const sheet = (await drawer(page).boundingBox())!;
        return text.y >= 31 && text.y + text.height < sheet.y;
      })
      .toBe(true);
    const first = page.getByRole("option").first();
    await expect
      .poll(() =>
        first.evaluate((el) => {
          const option = el.getBoundingClientRect();
          const scroll = el
            .closest('[data-slot="drawer-content"]')!
            .querySelector(".overflow-y-auto")!
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
            .closest('[data-slot="drawer-content"]')!
            .querySelector(".overflow-y-auto")!
            .getBoundingClientRect();
          return option.top >= scroll.top && option.bottom <= scroll.bottom;
        }),
      )
      .toBe(true);
    await drawer(page)
      .getByRole("button", { name: "Close", exact: true })
      .tap();
    await expect(editor(page)).toHaveText("/");
    await expect(editor(page)).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.body).paddingBottom),
      )
      .toBe("0px");
  });

  test("tag and link suggestions insert into the same focused node", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("#urg");
    await expect(drawer(page)).toBeVisible();
    await expect(editor(page)).toBeFocused();
    await page.locator('[role="option"] .tag-option[data-tag="urgent"]').tap();
    await expect(editor(page).locator('.tag[data-tag="urgent"]')).toBeVisible();
    await expect(drawer(page)).toHaveCount(0);
    await page.keyboard.type(" [[Phoe");
    await expect(drawer(page)).toBeVisible();
    await expect(editor(page)).toBeFocused();
    await page.getByRole("option", { name: /Project Phoenix/ }).tap();
    await expect(
      editor(page).locator(`[data-node-link="${TARGET}"]`),
    ).toBeVisible();
    await expect(drawer(page)).toHaveCount(0);
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
    await settleDrawer(page);
    const caretVisible = () =>
      editor(page).evaluate((el) => {
        const range = window.getSelection()!.getRangeAt(0).cloneRange();
        range.collapse(false);
        const caret = range.getBoundingClientRect();
        const bottom =
          document
            .querySelector('[data-slot="drawer-popup"]')
            ?.getBoundingClientRect().top ?? 291;
        const hit = document.elementFromPoint(
          caret.left - 1,
          (caret.top + caret.bottom) / 2,
        );
        return caret.top >= 31 && caret.bottom < bottom && el.contains(hit);
      });
    await expect.poll(caretVisible).toBe(true);
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("div.sticky").first()).toHaveCSS(
      "position",
      "sticky",
    );
    await expect.poll(caretVisible).toBe(true);
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
    await settleDrawer(page);
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
    ).toHaveAttribute("data-slot", "drawer-trigger");
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
    await load(page);
    await page.keyboard.press("q");
    await expect(quickAdd(page)).toBeVisible();
    const draft = page.locator(".quick-add-editor [contenteditable]");
    await draft.tap();
    await page.keyboard.type("Capture /todo");
    await expect(drawer(page)).toBeVisible();
    await expect(draft).toBeFocused();
    await settleDrawer(page);
    const draftBox = (await draft.boundingBox())!;
    const drawerBox = (await drawer(page).boundingBox())!;
    expect(draftBox.y + draftBox.height).toBeLessThan(drawerBox.y);
    await setVisualViewport(page, 260, 31);
    await settleDrawer(page);
    await expect
      .poll(async () => {
        const text = (await draft.boundingBox())!;
        const sheet = (await drawer(page).boundingBox())!;
        return text.y >= 31 && text.y + text.height < sheet.y;
      })
      .toBe(true);
    await expect(draft).toBeFocused();
    await setVisualViewport(page, 844, 0);
    await settleDrawer(page);
    await drawer(page)
      .getByRole("button", { name: "Close", exact: true })
      .tap();
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
    await swipeDrawer(page);
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
    await drawer(page).getByRole("option", { name: "Project Phoenix" }).tap();
    await expect(drawer(page)).toBeHidden();
    await expect(quickAdd(page)).toBeVisible();
    await expect(page.locator("[data-quick-add-dest]")).toHaveAttribute(
      "data-quick-add-dest",
      "Project Phoenix",
    );
    await expect(draft).toHaveText("Capture /todo");
    await expect(draft).toBeFocused();
  });

  test("date suggestions use the drawer and insert a date token", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("[[2030-06-12");
    await expect(drawer(page)).toBeVisible();
    await page.getByRole("option").first().tap();
    await expect(
      editor(page).locator('[data-date-link="2030-06-12"]'),
    ).toBeVisible();
    await expect(editor(page)).toBeFocused();
  });

  test("swiping dismisses commands without editing or blurring the node", async ({
    page,
  }) => {
    await load(page);
    await editor(page).tap();
    await page.keyboard.type("/");
    await expect(drawer(page)).toBeVisible();
    await swipeDrawer(page);
    await expect(drawer(page)).toHaveCount(0);
    await expect(editor(page)).toHaveText("/");
    await expect(editor(page)).toBeFocused();
  });

  test("opening another dialog from More transfers focus without leaving a drawer", async ({
    page,
  }) => {
    await load(page);
    await page.getByRole("button", { name: /More actions/ }).tap();
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
    const scroll = drawer(page).locator(".overflow-y-auto");
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
    await page.getByTestId("month-picker-next").tap();
    await expect(drawer(page)).toContainText("July 2030");
    await settleDrawer(page);
    const day = drawer(page).locator('[data-day-key="2030-07-15"]');
    expect((await day.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await day.tap();
    await expect(page).toHaveURL(new RegExp(`/${TARGET}$`));
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

test("mouse handle dragging dismisses commands without losing the caret", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page);
  await editor(page).click();
  await page.keyboard.type("/");
  await settleDrawer(page);
  const handle = (await drawer(page)
    .locator('[data-slot="drawer-swipe-handle"]')
    .boundingBox())!;
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, 840, { steps: 10 });
  await page.mouse.up();
  await expect(drawer(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveText("/");
});

test("keyboard opening More focuses its first item and supports immediate arrows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page);
  const trigger = page.getByRole("button", { name: /More actions/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const items = drawer(page).locator('button[role^="menuitem"]:not(:disabled)');
  const disabled = drawer(page).locator('button[role^="menuitem"]:disabled');
  await expect(disabled).toHaveCount(2);
  await expect(disabled.first()).toHaveCSS("opacity", "0.5");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
