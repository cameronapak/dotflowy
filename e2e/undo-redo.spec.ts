import { expect, test } from "@playwright/test";

import { seedOutline, STANDARD_TREE, type ApiNode } from "./fixtures";

test.use({ deviceScaleFactor: 2 });

test("the first node after emptying the outline can be undone and redone", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(page.locator('li[data-node-id="alpha"]')).toBeVisible({
    timeout: 60_000,
  });
  for (const id of ["alpha", "bravo", "charlie"]) {
    await page
      .locator(`li[data-node-id="${id}"] > .outline-row .node-text`)
      .click();
    await page.keyboard.press("ControlOrMeta+Shift+Backspace");
  }
  await expect(page.locator("li[data-node-id]")).toHaveCount(0);
  await page
    .getByRole("region", { name: "Outline", exact: true })
    .locator("button")
    .last()
    .click();
  await expect(page.locator("li[data-node-id]")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("li[data-node-id]")).toHaveCount(0);
  await page.getByRole("button", { name: /^More actions/ }).click();
  await expect(
    page.getByRole("menuitem", { name: /^Redo create$/ }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator("li[data-node-id]")).toHaveCount(1);
});

test("hidden undo preserves the filter and offers View node", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const bravo = page.locator(
    'li[data-node-id="bravo"] > .outline-row .node-text',
  );
  await expect(bravo).toBeVisible({ timeout: 60_000 });
  await bravo.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" hidden");
  await page.keyboard.press("ControlOrMeta+f");
  const filter = page.getByRole("combobox", { name: "Filter query" });
  await filter.fill("Alpha");
  await page.getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: /^Undo typing/ }).click();
  await expect(filter).toHaveValue("Alpha");
  const view = page.getByRole("button", { name: "View node", exact: true });
  await expect(page.getByText("Undid typing", { exact: true })).toBeVisible();
  await expect(view).toBeInViewport();
  if (process.env.HISTORY_CAPTURE)
    await page.screenshot({
      path: ".amp/in/artifacts/undo-hidden-toast.png",
      animations: "disabled",
    });
  await view.click();
  await expect(page).toHaveURL(/\/bravo\?q=Alpha$/);
  await expect(page.locator('[data-history-key="bravo"].node-text')).toHaveText(
    "Bravo",
  );
  await expect(filter).toHaveValue("Alpha");
});

test("snapshots preserve unchanged authoring history but clear it for external edits", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" kept");
  const readNodes = () =>
    page.evaluate(async (): Promise<ApiNode[]> =>
      (await fetch("/api/nodes")).json(),
    );
  const savedText = async () =>
    (await readNodes()).find((node) => node.id === "alpha")?.text;
  await expect.poll(savedText).toBe("Alpha kept");
  server.sendSnapshot(
    (await readNodes()).map((node) =>
      node.id === "alpha" ? { ...node, collapsed: true } : node,
    ),
  );
  await expect(page.locator('li[data-node-id="alpha-1"]')).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha");
  await expect(page.locator('li[data-node-id="alpha-1"]')).toHaveCount(0);
  await expect.poll(savedText).toBe("Alpha");
  server.sendSnapshot();
  await page.getByRole("button", { name: /^More actions/ }).click();
  const redo = page.getByRole("menuitem", { name: /^Redo typing$/ });
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(alpha).toHaveText("Alpha kept");
  await expect(page.getByText("History cleared", { exact: true })).toHaveCount(
    0,
  );
  await expect.poll(savedText).toBe("Alpha kept");
  server.sendSnapshot(
    (await readNodes()).map((node) =>
      node.id === "alpha" ? { ...node, text: "External latest" } : node,
    ),
  );
  await expect(alpha).toHaveText("External latest");
  await expect(
    page.getByText("History cleared", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^More actions/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Undo$/ })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: /^Redo$/ })).toBeDisabled();
});

test("external collapse during a pending text write preserves history", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  const current: ApiNode[] = await page.evaluate(async () =>
    (await fetch("/api/nodes")).json(),
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending = false;
  await page.route("**/api/nodes", async (route) => {
    if (route.request().method() === "PATCH") {
      pending = true;
      await held;
    }
    await route.fallback();
  });
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" local");
  await expect.poll(() => pending).toBe(true);
  try {
    await server.injectExternalChange([
      {
        op: "update",
        value: {
          ...current.find((node) => node.id === "alpha")!,
          collapsed: true,
        },
      },
    ]);
  } finally {
    release();
  }
  await expect(page.locator('li[data-node-id="alpha-1"]')).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha");
  await expect(page.locator('li[data-node-id="alpha-1"]')).toHaveCount(0);
  await expect(page.getByText("History cleared", { exact: true })).toHaveCount(
    0,
  );
});

test("external browsing changes preserve authoring history and remain live after undo", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" kept");
  const readNodes = () =>
    page.evaluate(async (): Promise<ApiNode[]> =>
      (await fetch("/api/nodes")).json(),
    );
  await expect
    .poll(
      async () => (await readNodes()).find((node) => node.id === "alpha")?.text,
    )
    .toBe("Alpha kept");
  const current = (await readNodes()).find((node) => node.id === "alpha")!;
  await server.injectExternalChange([
    {
      op: "update",
      value: { ...current, collapsed: true, bookmarkedAt: 123, updatedAt: 999 },
    },
  ]);
  await expect(page.locator('li[data-node-id="alpha-1"]')).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha");
  await expect(page.locator('li[data-node-id="alpha-1"]')).toHaveCount(0);
  await expect(page.getByText("History cleared", { exact: true })).toHaveCount(
    0,
  );
});

test("More exposes disabled history, then typing can be undone and redone", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /^More actions/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Undo$/ })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: /^Redo$/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" updated");
  await page.getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: /^Undo typing/ }).click();
  await expect(alpha).toHaveText("Alpha");
  await page.getByRole("button", { name: /^More actions/ }).click();
  await page.getByRole("menuitem", { name: /^Redo typing/ }).click();
  await expect(alpha).toHaveText("Alpha updated");
  if (process.env.HISTORY_CAPTURE) {
    await page.getByRole("button", { name: /^More actions/ }).click();
    await page.screenshot({ path: ".amp/in/artifacts/undo-more-menu.png" });
  }
});

test("title undo returns to the editing root and Cmd+K can redo it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/alpha");
  const title = page.locator('[data-history-key="alpha"].node-text');
  await expect(title).toBeVisible({ timeout: 60_000 });
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" title");
  await page.locator("nav.breadcrumb button").first().click();
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page).toHaveURL(/\/alpha$/);
  await expect(title).toHaveText("Alpha");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await page.getByRole("option", { name: /Redo typing/ }).click();
  await expect(title).toHaveText("Alpha title");
});

test("external edits clear both history directions, but our own echoes do not", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  const bravo = page.locator(
    'li[data-node-id="bravo"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.click();
  await page.keyboard.type("one");
  await bravo.click();
  await page.keyboard.type("two");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(bravo).toHaveText("Bravo");
  await server.injectExternalChange([{ op: "delete", key: "charlie" }]);
  await expect(
    page.getByText("History cleared", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^More actions/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Undo$/ })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: /^Redo$/ })).toBeDisabled();
});

test("failed undo rolls back and keeps the action available to retry", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const server = await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" revised");
  server.failNextWrite();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page.getByText("Undoing failed. Nothing was changed."),
  ).toBeVisible();
  await expect(alpha).toHaveText("Alpha revised");
  await page.getByRole("button", { name: /^More actions/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Redo$/ })).toBeDisabled();
  await page.getByRole("menuitem", { name: /^Undo typing/ }).click();
  await expect(alpha).toHaveText("Alpha");
});

test("quick-add undo stays in the current thought and closing makes capture one step", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/?q=Alpha");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" kept");
  await alpha.evaluate((el: HTMLElement) => el.blur());
  await page.keyboard.press("q");
  const draft = page.getByRole("textbox", { name: "Quick add", exact: true });
  await expect(draft).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha kept");
  await draft.click();
  await page.keyboard.type("first thought");
  await expect(draft).toHaveAttribute(
    "data-history-node-id",
    /^(?!__quick_add_draft__).+/,
  );
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(draft).toHaveText("");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page
      .getByRole("dialog", { name: "Quick add", exact: true })
      .getByText("first thought", { exact: true }),
  ).toBeVisible();
  await expect(alpha).toHaveText("Alpha kept");
  await page.evaluate(() => {
    // SAFETY: quick-add exposes this destination-resolution gate only in development.
    (
      window as Window & { __quickAddHoldResolve: () => void }
    ).__quickAddHoldResolve();
  });
  await page.keyboard.type("second thought");
  await page.keyboard.press("Enter");
  await expect(draft).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await page.evaluate(() => {
    // SAFETY: paired with the development-only gate above.
    (
      window as Window & { __quickAddReleaseResolve: () => void }
    ).__quickAddReleaseResolve();
  });
  await expect(page.getByText("Undid capture", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^More actions/ }).click();
  await expect(
    page.getByRole("menuitem", { name: /^Redo capture/ }),
  ).toBeEnabled();
  await page.getByRole("menuitem", { name: /^Redo capture/ }).click();
  await expect(page.getByText("Redid capture", { exact: true })).toBeVisible();
  await expect(alpha).toHaveText("Alpha kept");
});

test("structural keyboard edits wait until a restore finishes", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" revision");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let restoring = false;
  await page.route("**/api/nodes", async (route) => {
    if (route.request().method() === "POST") {
      restoring = true;
      await held;
    }
    await route.fallback();
  });
  const rowsBefore = await page.locator("li[data-node-id]").count();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => restoring).toBe(true);
  await page.keyboard.press("Enter");
  const rowsDuring = await page.locator("li[data-node-id]").count();
  release();
  expect(rowsDuring).toBe(rowsBefore);
  await expect(alpha).toHaveText("Alpha");
});

test("selection replacement is separate from typing and undo restores the source selection", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" suffix");
  await alpha.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.firstChild!, 1);
    range.setEnd(el.firstChild!, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type("X");
  await expect(alpha).toHaveText("AXa suffix");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha suffix");
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("lph");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha");
});

test("one IME composition is one undo step", async ({ page }) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.click();
  await page.keyboard.press("End");
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", {
    text: "文",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await ime.send("Input.imeSetComposition", {
    text: "文章",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await ime.send("Input.insertText", { text: "文章" });
  await expect(alpha).toHaveText("Alpha文章");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha");
});

test("undoing a selected-node delete restores the selected range", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator('li[data-node-id="alpha"]');
  const bravo = page.locator('li[data-node-id="bravo"]');
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.locator(":scope > .outline-row .node-text").click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Backspace");
  await expect(alpha).toHaveCount(0);
  await expect(bravo).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toBeVisible();
  await expect(bravo).toBeVisible();
  await expect(alpha).toHaveAttribute("data-selected", "top");
  await expect(bravo).toHaveAttribute("data-selected", "bottom");
  await page.keyboard.press("Backspace");
  await expect(alpha).toHaveCount(0);
  await expect(bravo).toHaveCount(0);
});

test("one quick-add typing run includes the first character and can be redone", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(page.locator('li[data-node-id="alpha"]')).toBeVisible({
    timeout: 60_000,
  });
  await page.keyboard.press("q");
  await page.locator("[data-quick-add-dest]").click();
  await page.getByRole("option", { name: "Top level", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Quick add", exact: true });
  await draft.click();
  await page.keyboard.type("a");
  await expect(draft).toHaveAttribute(
    "data-history-node-id",
    /^(?!__quick_add_draft__).+/,
  );
  await page.keyboard.type(" capture");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(draft).toHaveText("");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(draft).toHaveText("a capture");
});

test("undo in a filter input does not undo outline authoring", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" kept");
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("combobox", { name: "Filter query" }).fill("Alpha");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha kept");
});

test.describe("mobile history actions", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 412, height: 900 },
  });
  test("the editing capsule disables unavailable actions and keeps focus through undo", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await seedOutline(page, STANDARD_TREE);
    await page.goto("/");
    const alpha = page.locator(
      'li[data-node-id="alpha"] > .outline-row .node-text',
    );
    await expect(alpha).toBeVisible({ timeout: 60_000 });
    await alpha.click();
    const bar = page.locator("[data-mobile-bar]");
    await expect(
      bar.getByRole("button", { name: "Undo", exact: true }),
    ).toBeDisabled();
    await expect(
      bar.getByRole("button", { name: "Redo", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("End");
    await page.keyboard.type(" mobile");
    await bar.getByRole("button", { name: "Undo typing", exact: true }).click();
    await expect(alpha).toHaveText("Alpha");
    await expect(alpha).toBeFocused();
    await expect(
      bar.getByRole("button", { name: "Redo typing", exact: true }),
    ).toBeEnabled();
    if (process.env.HISTORY_CAPTURE)
      await page.screenshot({
        path: ".amp/in/artifacts/undo-mobile-capsule.png",
      });
  });
});
