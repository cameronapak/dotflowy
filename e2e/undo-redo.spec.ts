import { expect, test, type Page } from "@playwright/test";

import {
  holdDailyClaims,
  mockKeyboardViewport,
  placeCaret,
  seedOutline,
  STANDARD_TREE,
  type ApiNode,
} from "./fixtures";

// Text updates before replay finishes its persistence and caret/paint work.
// Wait for the existing edit gate so a second shortcut is not intentionally ignored.
async function replay(page: Page, kind: "undo" | "redo") {
  const idle = () =>
    expect
      .poll(() =>
        page.evaluate(async () => {
          const path = "/src/data/history.ts";
          return (await import(path)).getHistoryState().busy;
        }),
      )
      .toBe(false);
  await idle();
  await page.keyboard.press(
    kind === "undo" ? "ControlOrMeta+z" : "ControlOrMeta+Shift+z",
  );
  await idle();
}

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
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  await expect(page.locator("li[data-node-id]")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("li[data-node-id]")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await expect(
    page.getByRole("option", { name: /^Redo create/ }),
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
  await placeCaret(bravo, "end");
  await page.keyboard.type(" hidden");
  await page.keyboard.press("ControlOrMeta+f");
  const filter = page.getByRole("combobox", { name: "Filter query" });
  await filter.fill("Alpha");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("undo");
  await page.getByRole("option", { name: /^Undo typing/ }).click();
  await expect(filter).toHaveValue("Alpha");
  const view = page.getByRole("button", { name: "View node", exact: true });
  await expect(page.getByText("Undid typing", { exact: true })).toBeVisible();
  await expect(view).toBeInViewport();
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
  await placeCaret(alpha, "end");
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
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  const redo = page.getByRole("option", { name: /^Redo typing/ });
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
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("undo");
  await expect(page.getByRole("option", { name: /^Undo / })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await expect(page.getByRole("option", { name: /^Redo / })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
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
  await placeCaret(alpha, "end");
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
  await placeCaret(alpha, "end");
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

test("Cmd+K exposes disabled history, then typing can be undone and redone", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("undo");
  await expect(page.getByRole("option", { name: /^Undo / })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await expect(page.getByRole("option", { name: /^Redo / })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await placeCaret(alpha, "end");
  await page.keyboard.type(" updated");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("undo");
  await page.getByRole("option", { name: /^Undo typing/ }).click();
  await expect(alpha).toHaveText("Alpha");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await page.getByRole("option", { name: /^Redo typing/ }).click();
  await expect(alpha).toHaveText("Alpha updated");

  // The DOM updates before restore's caret/paint work releases the edit gate.
  const pressWhenReady = async (key: string) => {
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = "/src/data/history.ts";
          return (await import(path)).getHistoryState().busy;
        }),
      )
      .toBe(false);
    await page.keyboard.press(key);
  };
  await pressWhenReady("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha");
  // Indenting the first root is a captured no-op, not a new timeline.
  await placeCaret(alpha, "end");
  await pressWhenReady("Tab");
  await pressWhenReady("ControlOrMeta+Shift+z");
  await expect(alpha).toHaveText("Alpha updated");
  await pressWhenReady("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha");
  await pressWhenReady("End");
  await page.keyboard.type(" branch");
  await page.keyboard.type(" continued");
  await pressWhenReady("ControlOrMeta+Shift+z");
  await expect(alpha).toHaveText("Alpha branch continued");
  await pressWhenReady("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha");
  await pressWhenReady("ControlOrMeta+Shift+z");
  await expect(alpha).toHaveText("Alpha branch continued");
});

test("title undo returns to the editing root and Cmd+K can redo it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/alpha");
  const title = page.locator(".zoomed-title-text");
  await expect(title).toBeVisible({ timeout: 60_000 });
  await placeCaret(title, "end");
  await page.keyboard.type(" title");
  await page
    .getByRole("navigation", { name: "Breadcrumb", exact: true })
    .getByRole("button", { name: "", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  const row = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  // Redo saves where undo is invoked, not the earlier title-editing location.
  await placeCaret(row, 2);
  await replay(page, "undo");
  await expect(page).toHaveURL(/\/alpha$/);
  await expect(title).toHaveText("Alpha");
  await expect(title).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(5);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await page.getByRole("option", { name: /Redo typing/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(row).toHaveText("Alpha title");
  await expect(row).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(2);
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
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("undo");
  await expect(page.getByRole("option", { name: /^Undo / })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await expect(page.getByRole("option", { name: /^Redo / })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
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
  await placeCaret(alpha, "end");
  await page.keyboard.type(" revised");
  server.failNextWrite();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page.getByText("Undoing failed. Nothing was changed."),
  ).toBeVisible();
  await expect(alpha).toHaveText("Alpha revised");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await expect(page.getByRole("option", { name: /^Redo / })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.getByPlaceholder("Search nodes and actions...").fill("undo");
  await page.getByRole("option", { name: /^Undo typing/ }).click();
  await expect(alpha).toHaveText("Alpha");
});

test("quick-add undo stays in the current thought and closing makes capture one step", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date(2030, 5, 10, 12));
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/?q=Alpha");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await placeCaret(alpha, "end");
  await page.keyboard.type(" kept");
  await alpha.evaluate((el: HTMLElement) => el.blur());
  await page.keyboard.press("q");
  const draft = page.getByRole("textbox", { name: "Quick add", exact: true });
  const historyBusy = () =>
    page.evaluate(async () => {
      const historyPath = "/src/data/history.ts";
      return (await import(historyPath)).getHistoryState().busy;
    });
  await expect(draft).toBeVisible();
  await expect(draft).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(historyBusy).toBe(false);
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
  // Even a scoped no-op drains pending captures/writes before releasing input.
  await expect.poll(historyBusy).toBe(false);
  await expect(
    page
      .getByRole("dialog", { name: "Quick add", exact: true })
      .getByText("first thought", { exact: true }),
  ).toBeVisible();
  await expect(alpha).toHaveText("Alpha kept");
  await page.clock.setFixedTime(new Date(2030, 5, 11, 12));
  const gate = await holdDailyClaims(page);
  await page.keyboard.type("second thought");
  await expect(draft).toHaveText("second thought");
  await gate.seen;
  await page.keyboard.press("Enter");
  await expect(draft).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  gate.release();
  await expect(page.getByText("Undid capture", { exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search nodes and actions...").fill("redo");
  await expect(
    page.getByRole("option", { name: /^Redo capture/ }),
  ).toBeEnabled();
  await page.getByRole("option", { name: /^Redo capture/ }).click();
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
  await placeCaret(alpha, "end");
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
  await placeCaret(alpha, "end");
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

test("unrelated editable owners keep separate typing runs and caret locations", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Equal caret offsets and a fixed clock make host identity the only boundary.
  await page.clock.setFixedTime(new Date(2030, 5, 10, 12));
  await seedOutline(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "Alpha" },
    { id: "b", parentId: null, prevSiblingId: "a", text: "Second" },
  ]);
  await page.goto("/");
  const a = page.locator('[data-history-key="a"].node-text');
  const b = page.locator('[data-history-key="b"].node-text');
  await expect(a).toBeVisible({ timeout: 60_000 });
  await placeCaret(a, "end");
  await page.keyboard.type("x");
  await placeCaret(b, "end");
  await page.keyboard.type("yz");
  await expect(a).toHaveText("Alphax");
  await expect(b).toHaveText("Secondyz");

  await replay(page, "undo");
  await expect(b).toHaveText("Second");
  await expect(a).toHaveText("Alphax");
  await expect(b).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(6);
  await replay(page, "undo");
  await expect(a).toHaveText("Alpha");
  await expect(a).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(5);
  await replay(page, "redo");
  await expect(a).toHaveText("Alphax");
  await replay(page, "redo");
  await expect(b).toHaveText("Secondyz");
  await expect(b).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(8);
  await page.reload();
  await expect(a).toHaveText("Alphax");
  await expect(b).toHaveText("Secondyz");
});

test("source and mirror render paths separate typing and restore their own selection", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date(2030, 5, 10, 12));
  await seedOutline(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "Parent" },
    { id: "child", parentId: "a", prevSiblingId: null, text: "Seed" },
    { id: "m", parentId: null, prevSiblingId: "a", text: "", mirrorOf: "a" },
  ]);
  await page.goto("/");
  const instances = page.locator('[data-history-node-id="child"].node-text');
  await expect(instances).toHaveCount(2, { timeout: 60_000 });
  const source = instances.nth(0);
  const mirror = instances.nth(1);
  await placeCaret(source, "end");
  await page.keyboard.type("x");
  await expect(mirror).toHaveText("Seedx");
  await placeCaret(mirror, "end");
  await page.keyboard.type("yz");
  await expect(source).toHaveText("Seedxyz");
  await replay(page, "undo");
  await expect(source).toHaveText("Seedx");
  await expect(mirror).toHaveText("Seedx");
  await expect(mirror).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(5);
  await replay(page, "undo");
  await expect(mirror).toHaveText("Seed");
  await expect(source).toBeFocused();
  await replay(page, "redo");
  await expect(mirror).toHaveText("Seedx");
  // Redo restores the location saved when undo was invoked: the mirror after
  // the first undo, even though the second undo changed the source's typing.
  await expect(mirror).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(5);
  await replay(page, "redo");
  await expect(source).toHaveText("Seedxyz");
  await expect(mirror).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(7);

  // A noncollapsed selection belongs to this render path, not just its source.
  await mirror.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.firstChild!, 1);
    range.setEnd(el.firstChild!, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await page.keyboard.type("Q");
  await expect(source).toHaveText("SQxyz");
  await replay(page, "undo");
  await expect(mirror).toHaveText("Seedxyz");
  await expect(mirror).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("eed");
  await replay(page, "redo");
  await expect(source).toHaveText("SQxyz");
  await expect(mirror).toHaveText("SQxyz");
  await expect(mirror).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = window.getSelection()!;
        return [selection.anchorOffset, selection.focusOffset];
      }),
    )
    .toEqual([2, 2]);
  await page.reload();
  await expect(source).toHaveText("SQxyz");
  await expect(mirror).toHaveText("SQxyz");
});

test("IME composition stays together across pauses but never joins another owner", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date(2030, 5, 10, 12));
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await placeCaret(alpha, "end");
  await page.keyboard.type("x");
  // CDP drives Chromium's composition events, not a native OS IME or iPhone.
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", {
    text: "文",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await page.clock.setFixedTime(new Date(2030, 5, 10, 12, 0, 5));
  await ime.send("Input.imeSetComposition", {
    text: "文章",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await ime.send("Input.insertText", { text: "文章" });
  await expect(alpha).toHaveText("Alphax文章");
  const bravo = page.locator('[data-history-key="bravo"].node-text');
  await placeCaret(bravo, "end");
  await ime.send("Input.imeSetComposition", {
    text: "別",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await ime.send("Input.insertText", { text: "別" });
  await expect(bravo).toHaveText("Bravo別");
  await replay(page, "undo");
  await expect(bravo).toHaveText("Bravo");
  await expect(alpha).toHaveText("Alphax文章");
  await expect(bravo).toBeFocused();
  await replay(page, "undo");
  await expect(alpha).toHaveText("Alphax");
  await expect(alpha).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(6);
  await replay(page, "undo");
  await expect(alpha).toHaveText("Alpha");
  await replay(page, "redo");
  await expect(alpha).toHaveText("Alphax");
  await replay(page, "redo");
  await expect(alpha).toHaveText("Alphax文章");
  await replay(page, "redo");
  await expect(bravo).toHaveText("Bravo別");
  await expect(bravo).toBeFocused();
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
  await page.clock.setFixedTime(new Date(2030, 5, 10, 12));
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
  await expect(draft).toHaveAttribute(
    "data-history-node-id",
    "__quick_add_draft__",
  );
  const host = await draft.elementHandle();
  await page.keyboard.type("a");
  await expect(draft).toHaveAttribute(
    "data-history-node-id",
    /^(?!__quick_add_draft__).+/,
  );
  // Adoption changes logical ownership without replacing the editable host.
  expect(await draft.evaluate((el, original) => el === original, host)).toBe(
    true,
  );
  await page.keyboard.type(" capture");
  await replay(page, "undo");
  await expect(draft).toHaveText("");
  await expect(draft).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(0);
  await replay(page, "redo");
  await expect(draft).toHaveText("a capture");
  await expect(draft).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset))
    .toBe(9);
  await page.keyboard.press("Enter");
  await expect(draft).toHaveCount(0);
  await page.reload();
  await expect(
    page.locator(".outline-row .node-text").filter({ hasText: /^a capture$/ }),
  ).toHaveCount(1);
});

test("undo and redo in a filter input stay separate from outline authoring", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  const alpha = page.locator(
    'li[data-node-id="alpha"] > .outline-row .node-text',
  );
  await expect(alpha).toBeVisible({ timeout: 60_000 });
  await placeCaret(alpha, "end");
  await page.keyboard.type(" kept");
  await page.keyboard.press("ControlOrMeta+f");
  const filter = page.getByRole("combobox", { name: "Filter query" });
  await expect(filter).toBeFocused();
  await page.keyboard.type("Alpha");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(filter).toHaveValue("");
  await expect(alpha).toHaveText("Alpha kept");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(filter).toHaveValue("Alpha");
  await expect(alpha).toHaveText("Alpha kept");

  await placeCaret(alpha, "end");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(alpha).toHaveText("Alpha");
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
    await mockKeyboardViewport(page);
    await seedOutline(page, STANDARD_TREE);
    await page.goto("/");
    const alpha = page.locator(
      'li[data-node-id="alpha"] > .outline-row .node-text',
    );
    await expect(alpha).toBeVisible({ timeout: 60_000 });
    await alpha.click();
    const bar = page.getByRole("toolbar", {
      name: "Editing actions",
      exact: true,
    });
    await expect(
      bar.getByRole("button", { name: "Undo", exact: true }),
    ).toBeDisabled();
    await expect(
      bar.getByRole("button", { name: "Redo", exact: true }),
    ).toBeDisabled();
    await placeCaret(alpha, "end");
    await page.keyboard.type(" mobile");
    await bar.getByRole("button", { name: "Undo typing", exact: true }).click();
    await expect(alpha).toHaveText("Alpha");
    await expect(alpha).toBeFocused();
    await expect(
      bar.getByRole("button", { name: "Redo typing", exact: true }),
    ).toBeEnabled();
  });
});
