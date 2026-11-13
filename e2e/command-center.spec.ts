import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  type SeedNode,
} from "./fixtures";

// A small nested tree: alpha has a subtree (for "Collapse all"), bravo is a
// sibling to indent under alpha, zephyr is a distinctive leaf whose text matches
// NO action keyword (so a query for it highlights the node result, not an
// action row -- the per-result `->` path needs the node highlighted).
//
//   Alpha (alpha)
//     Alpha one (alpha-1)
//       Alpha one deep (alpha-1-a)
//   Bravo (bravo)
//   Zephyr (zephyr)
const TREE: SeedNode[] = [
  { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
  { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
  { id: "zephyr", parentId: null, prevSiblingId: "bravo", text: "Zephyr" },
  { id: "alpha-1", parentId: "alpha", prevSiblingId: null, text: "Alpha one" },
  {
    id: "alpha-1-a",
    parentId: "alpha-1",
    prevSiblingId: null,
    text: "Alpha one deep",
  },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page) {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "alpha" });
}

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByPlaceholder(/Search nodes and actions/)).toBeVisible();
}

test("Spotlight commands preserve the zoomed child's source caret", async ({
  page,
}) => {
  await seedOutline(
    page,
    TREE.map((node) =>
      node.id === "alpha-1"
        ? { ...node, text: "Before **bright** after" }
        : node,
    ),
  );
  await openSeededOutline(page, { path: "/alpha", anchorId: "alpha-1" });
  const child = text(page, "alpha-1");
  // Inside a folding token: blur replaces its DOM, so a saved DOM Range is stale.
  await placeCaret(child, 7);
  await expect(child).toHaveText("Before **bright** after");
  await placeCaret(child, 12);
  for (const enabled of [true, false]) {
    await openPalette(page);
    await page.getByPlaceholder(/Search nodes and actions/).fill("spotlight");
    await page
      .getByRole("option", {
        name: enabled ? /^Spotlight mode/ : /^Turn off spotlight mode/,
      })
      .click();
    await expect(page.getByRole("dialog", { name: "Find" })).toHaveCount(0);
    await expect(child).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Turn off spotlight mode" }),
    ).toHaveCount(enabled ? 1 : 0);
    // Typing immediately must insert at the saved source offset, not start/end.
    await page.keyboard.type("!");
    await expect(child).toHaveText("Before **bri!ght** after");
    await page.keyboard.press("Backspace");
    await expect(child).toHaveText("Before **bright** after");
  }
});

test("Spotlight commands preserve title carets and retain no-editor fallbacks", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { path: "/alpha", anchorId: "alpha-1" });
  const title = page.locator("h2.zoomed-title .node-text");
  const indicator = page.getByRole("button", {
    name: "Turn off spotlight mode",
  });
  const toggle = async () => {
    await openPalette(page);
    await page.getByPlaceholder(/Search nodes and actions/).fill("spotlight");
    await page.getByRole("option", { name: /spotlight mode/i }).click();
    await expect(page.getByRole("dialog", { name: "Find" })).toHaveCount(0);
  };
  await placeCaret(title, 2);
  for (const enabled of [true, false]) {
    await toggle();
    await expect(title).toBeFocused();
    await expect(indicator).toHaveCount(enabled ? 1 : 0);
    await page.keyboard.type("!");
    await expect(title).toHaveText("Al!pha");
    await page.keyboard.press("Backspace");
  }
  // Cancellation must not leave a queued toggle for the next palette close.
  await openPalette(page);
  await page.getByPlaceholder(/Search nodes and actions/).fill("spotlight");
  await page.keyboard.press("Escape");
  await expect(indicator).toHaveCount(0);
  await expect(title).toBeFocused();
  await title.evaluate((el: HTMLElement) => el.blur());
  await toggle();
  await expect(indicator).toBeVisible();
  await expect(title).toBeFocused();
  await page.keyboard.type("!");
  await expect(title).toHaveText("!Alpha");
  await toggle();
  await expect(indicator).toHaveCount(0);

  await openSeededOutline(page, { anchorId: "alpha" });
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await toggle();
  await expect(text(page, "alpha")).toBeFocused();
  await page.keyboard.type("?");
  await expect(text(page, "alpha")).toHaveText("?!Alpha");
});

test("View bookmarks the current page on desktop and removes it in the narrow sheet", async ({
  page,
}) => {
  await load(page);
  const view = page.getByRole("button", { name: "View options" });
  const bookmark = page.getByRole("menuitemcheckbox", {
    name: "Bookmark this page",
    exact: true,
  });
  await view.click();
  await expect(bookmark).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto("/alpha");
  // Page readiness uses the test budget, not the 5s interaction assertion budget.
  await page
    .locator("h2.zoomed-title .node-text")
    .waitFor({ state: "visible" });
  await view.click();
  await expect(bookmark).toHaveAttribute("aria-checked", "false");
  await bookmark.click();
  await expect(bookmark).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await openPalette(page);
  await expect(page.getByRole("option", { name: /Alpha/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.reload();
  await page
    .locator("h2.zoomed-title .node-text")
    .waitFor({ state: "visible" });
  await page.setViewportSize({ width: 390, height: 844 });
  // Narrow screens put View options in the More menu (ADR 0076).
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  await expect(bookmark).toHaveAttribute("aria-checked", "true");
  await bookmark.click();
  await expect(bookmark).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await openPalette(page);
  await expect(
    page.getByText("No bookmarks yet.", { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/");
  await text(page, "alpha").waitFor({ state: "visible" });
  await more.click();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  await expect(bookmark).toHaveCount(0);
});

test.describe("mobile", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("centers within the visual viewport after keyboard resize and pan", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 412, height: 900 });
    await load(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    await text(page, "bravo").click();
    await openPalette(page);
    const dialog = page.getByRole("dialog", { name: "Find" });
    const center = () =>
      dialog.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });

    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperties(vv, {
        height: { configurable: true, value: 277 },
        offsetTop: { configurable: true, value: 103 },
      });
      vv.dispatchEvent(new Event("resize"));
    });
    await expect.poll(center).toBeCloseTo(241.5, 0); // 103 + 277 / 2
    const bounds = await dialog.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(103); // native modal follows visible top
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(380); // visible bottom
    const input = page.getByPlaceholder(/Search nodes and actions/);
    await expect(input).toBeFocused();
    const inputTop = (await input.boundingBox())!.y;
    const list = dialog.locator("[cmdk-list]");
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
      true,
    );
    // Reach the final action through the keyboard, not the bottom of the
    // trailing empty-bookmarks hint, which can fill a short keyboard viewport.
    await input.press("End");
    const last = dialog.getByRole("option").last();
    await expect(last).toHaveAttribute("data-selected", "true");
    await expect
      .poll(async () => {
        const bounds = (await last.boundingBox())!;
        const listBounds = (await list.boundingBox())!;
        return (
          bounds.y >= listBounds.y &&
          bounds.y + bounds.height <= listBounds.y + listBounds.height + 1
        );
      })
      .toBe(true);
    expect((await input.boundingBox())!.y).toBe(inputTop);

    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, "offsetTop", {
        configurable: true,
        value: 151,
      });
      vv.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(center).toBeCloseTo(289.5, 0); // 151 + 277 / 2

    await page.evaluate(() => {
      const vv = window.visualViewport!;
      Object.defineProperties(vv, {
        height: { configurable: true, value: 900 },
        offsetTop: { configurable: true, value: 0 },
      });
      vv.dispatchEvent(new Event("resize"));
    });
    await expect.poll(center).toBeCloseTo(450, 0);
  });
});

test("Find searches everywhere, prioritizes here, returns to selection, and hands off to Filter", async ({
  page,
}) => {
  const many: SeedNode[] = Array.from({ length: 55 }, (_, i) => ({
    id: `task-${i}`,
    parentId: "bravo",
    prevSiblingId: i === 0 ? null : `task-${i - 1}`,
    text: `Release checklist ${i} #launch`,
    isTask: true,
  }));
  await seedOutline(page, [
    ...TREE,
    {
      id: "near",
      parentId: "alpha",
      prevSiblingId: "alpha-1",
      text: "Release local #launch",
      isTask: true,
    },
    {
      id: "done",
      parentId: "alpha",
      prevSiblingId: "near",
      text: "Release done #launch",
      isTask: true,
      completed: true,
    },
    {
      id: "zephyr-mirror",
      parentId: "alpha",
      prevSiblingId: "done",
      text: "",
      mirrorOf: "zephyr",
    },
    ...many,
  ]);
  await openSeededOutline(page, { path: "/bravo", anchorId: "task-0" });
  await openSeededOutline(page, { path: "/alpha", anchorId: "alpha-1" });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Find", exact: true });
  const find = dialog.getByRole("combobox");
  const results = dialog.locator("[data-result-id]");
  await find.fill("Zephr"); // Typo tolerance remains available for plain words.
  await expect(results).toHaveCount(1);
  await expect(results.first()).toHaveAttribute("data-result-id", "zephyr");
  await expect(
    results.first().getByText("here", { exact: true }),
  ).toBeVisible();
  await find.fill('"');
  await expect(results).toHaveCount(0);
  await find.fill('""');
  await expect(results).toHaveCount(0);
  await find.fill('"Zephyr"');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toHaveAttribute("data-result-id", "zephyr");
  await expect(
    results.first().getByText("here", { exact: true }),
  ).toBeVisible();
  await find.fill('"Zephr"'); // Quotes switch to exact DQL, not fuzzy matching.
  await expect(results).toHaveCount(0);
  await find.fill("#launch is:todo -is:complete");
  await expect(dialog.getByText("Everywhere", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(/DQL|fuzzy matching|exact matching/),
  ).toHaveCount(0);
  await expect(results).toHaveCount(50);
  await expect(results.first()).toHaveAttribute("data-result-id", "near");
  await expect(
    results.first().getByText("here", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("group", { name: "Actions", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByText("Showing 50 of 56 matches")).toBeVisible();
  await results.nth(2).click();
  await expect(page).toHaveURL(/\/task-1$/);
  await expect(page).not.toHaveURL(/q=/);
  await page.getByRole("button", { name: "Back to search" }).click();
  await expect(page).toHaveURL(/\/alpha$/);
  await expect(find).toHaveValue("#launch is:todo -is:complete");
  await expect(dialog.locator('[data-result-id="task-1"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await find.press("Escape");
  await page.goBack();
  await expect(page).toHaveURL(/\/bravo$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/alpha$/);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await find.fill("#launch is:todo -is:complete");
  await find.press("Shift+Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/alpha\?q=/);
  await expect(page.locator('li[data-node-id="near"]')).toBeVisible();
  await expect(page.locator('li[data-node-id="task-0"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await find.fill("#launch is:todo -is:complete");
  await dialog.getByRole("option", { name: /^Filter Home for/ }).click();
  await expect(page).toHaveURL(/\/\?q=/);
  await expect(page.locator('li[data-node-id="bravo"]')).toBeVisible();
  await expect(page.locator('li[data-node-id="near"]')).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const todoShortcut = dialog.getByRole("button", {
    name: "To-do",
    exact: true,
  });
  await todoShortcut.focus();
  await todoShortcut.press("Enter");
  await expect(
    page.getByRole("menuitemradio", { name: "To-do", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(todoShortcut).toBeFocused();
  await todoShortcut.press("Enter");
  await page
    .getByRole("menuitemradio", { name: "To-do", exact: true })
    .press("Enter");
  await expect(find).toHaveValue("is:todo");
  await expect(find).toBeFocused();
  await dialog.getByRole("button", { name: "Completed", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Not completed", exact: true })
    .click();
  await expect(find).toHaveValue("is:todo -is:complete");
  await dialog.getByRole("button", { name: "Tag", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Include tag…", exact: true })
    .click();
  await dialog.getByRole("option", { name: "#launch", exact: true }).click();
  await expect(find).toHaveValue("is:todo -is:complete #launch ");
  await find.fill("#launch");
  await dialog.getByRole("button", { name: "Completed", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Completed", exact: true })
    .click();
  await expect(find).toHaveValue("#launch is:complete");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toHaveAttribute("data-result-id", "done");
  await dialog.getByRole("button", { name: "Completed", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Not completed", exact: true })
    .click();
  await expect(find).toHaveValue("#launch -is:complete");
  await dialog
    .getByRole("button", { name: "Not completed", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Completed", exact: true })
    .click();
  await expect(find).toHaveValue("#launch is:complete");
  await find.press("ControlOrMeta+f");
  await expect(dialog).toHaveCount(0);
  const filter = page.getByRole("combobox", { name: "Filter query" });
  await expect(filter).toHaveValue("#launch is:complete");
  await expect(filter).toBeFocused();
  await filter.fill("#launch");
  await expect(filter).toHaveValue("#launch");
  await page.getByRole("button", { name: "Completed", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Completed", exact: true })
    .click();
  await expect(filter).toHaveValue("#launch is:complete");
  await page.getByRole("button", { name: "#launch", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Exclude #launch", exact: true })
    .click();
  await expect(filter).toHaveValue("-#launch is:complete");
  await page.getByRole("button", { name: "Not #launch", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Remove filter", exact: true })
    .click();
  await expect(filter).toHaveValue("is:complete");
  await filter.fill("");
  await page.getByRole("button", { name: "Has children", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Has children", exact: true })
    .click();
  await expect(filter).toHaveValue("has:children");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await find.fill("");
  await dialog
    .getByRole("button", { name: "Has children", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Has children", exact: true })
    .click();
  await expect(find).toHaveValue("has:children");
  await expect(results).toHaveCount(3);
  await expect(results.nth(0)).toHaveAttribute("data-result-id", "alpha");
  await expect(results.nth(1)).toHaveAttribute("data-result-id", "alpha-1");
  await expect(results.nth(2)).toHaveAttribute("data-result-id", "bravo");
});

test("ambient target: a focused bullet's actions run against it", async ({
  page,
}) => {
  await load(page);
  // Focus Bravo -- the ambient target snapshot reads document.activeElement.
  await text(page, "bravo").click();
  await openPalette(page);

  // The ambient block names the target.
  await expect(page.getByText(/Acting on:\s*Bravo/)).toBeVisible();

  // Run "Indent": Bravo becomes a child of its previous sibling, Alpha.
  await page.getByRole("option", { name: /Indent/ }).click();

  await expect(page.locator('li[data-node-id="bravo"]')).toHaveAttribute(
    "data-parent-id",
    "alpha",
  );
});

test("per-result: -> opens a picked node's action sub-view", async ({
  page,
}) => {
  await load(page);
  await openPalette(page);
  await page.keyboard.press("Escape");
  // Reopening must read edits made while the closed palette skips its scan.
  await text(page, "zephyr").fill("Kestrel");
  await openPalette(page);

  await page.keyboard.type("kestrel");
  await expect(page.getByRole("option", { name: /Kestrel/ })).toBeVisible();

  // Arrow-right on the highlighted node result drills into its actions.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText(/Actions on:\s*Kestrel/)).toBeVisible();

  // Delete the node from the sub-view; its row disappears.
  await page.getByRole("option", { name: /Delete/ }).click();
  await expect(page.locator('li[data-node-id="zephyr"]')).toHaveCount(0);
});

test("Scribble mode covers active text, tokens, titles, and Quick-add without changing source", async ({
  page,
}) => {
  const source =
    "Draft **bold** `code` #focus [link](https://example.com) John 3:16 ||spoiler||";
  await seedOutline(
    page,
    TREE.map((node) =>
      node.id === "alpha" ? { ...node, text: source } : node,
    ),
  );
  await page.goto("/");
  const row = text(page, "alpha");
  await expect(row).toBeVisible({ timeout: 15000 });
  await openPalette(page);
  await page.getByPlaceholder(/Search nodes and actions/).fill("scribble");
  await page.getByRole("option", { name: /Turn on Scribble mode/ }).click();
  const off = page.getByRole("button", {
    name: "Turn off Scribble mode",
    exact: true,
  });
  await expect(off).toBeVisible();
  await expect(row).toHaveCSS("font-family", '"Redacted Script"');
  expect(
    await page.evaluate(
      async () => (await document.fonts.load('17px "Redacted Script"')).length,
    ),
  ).toBeGreaterThan(0);
  // Code and React widget text must not escape the font through their own styles.
  await expect(row.locator("code")).toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await expect(row.locator("[data-bible-ref]")).toBeVisible();
  await expect(row.locator("[data-bible-ref] span").first()).toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await text(page, "bravo").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" writing");
  await expect(text(page, "bravo")).toBeFocused();
  await expect(text(page, "bravo")).toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("!");
  await expect(text(page, "bravo")).toHaveText("Bravo writin!g");
  await openPalette(page);
  await page
    .getByPlaceholder(/Search nodes and actions/)
    .fill("Spotlight mode");
  await page.getByRole("option", { name: /Spotlight mode/ }).click();
  await text(page, "bravo").click();
  await expect(text(page, "bravo")).toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await expect(
    page.getByRole("button", { name: "Turn off spotlight mode" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Turn off spotlight mode" }).click();
  await page.reload();
  // The document loads before the lazy editor; check persistence once it mounts.
  await row.waitFor({ state: "visible" });
  await expect(off).toBeVisible();
  await expect(text(page, "bravo")).toHaveText("Bravo writin!g");
  await expect(row).toHaveCSS("font-family", '"Redacted Script"');
  expect(
    await page.evaluate(async () => (await fetch("/api/nodes")).json()),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "alpha", text: source }),
    ]),
  );

  await page.goto("/alpha");
  const title = page.locator("h2.zoomed-title .node-text");
  await title.waitFor({ state: "visible" });
  await expect(title).toHaveCSS("font-family", '"Redacted Script"');
  await expect(page.locator("header")).not.toHaveCSS(
    "font-family",
    '"Redacted Script"',
  );
  await openPalette(page);
  await page.getByPlaceholder(/Search nodes and actions/).fill("quick add");
  await page.getByRole("option", { name: /Quick add/ }).click();
  const capture = page.getByRole("textbox", { name: "Quick add", exact: true });
  await expect(capture).toBeFocused();
  await page.keyboard.type("A new thought");
  await expect(capture).toHaveCSS("font-family", '"Redacted Script"');
  await page.keyboard.press("Escape");
  await off.click();
  await expect(title).not.toHaveCSS("font-family", '"Redacted Script"');
  await expect(off).toHaveCount(0);

  await page.getByRole("button", { name: "View options" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Scribble mode", exact: true })
    .click();
  await expect(off).toBeVisible();
  await page.keyboard.press("Escape");
  await openPalette(page);
  await page.getByPlaceholder(/Search nodes and actions/).fill("scribble");
  await page.getByRole("option", { name: /Turn off Scribble mode/ }).click();
  await expect(title).not.toHaveCSS("font-family", '"Redacted Script"');
});
