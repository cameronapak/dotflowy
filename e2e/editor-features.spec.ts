import { expect, test } from "@playwright/test";

import { localDateKey } from "../src/data/date-links";
import { seedOutline, type SeedNode } from "./fixtures";

const TREE: SeedNode[] = [
  {
    id: "reflection",
    parentId: null,
    prevSiblingId: null,
    text: "Read John 3:16 and [[2030-04-12]]",
  },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/subscription/list", (route) =>
    route.fulfill({ json: [] }),
  );
});

test("feature switches default on and save independently across reloads", async ({
  page,
}) => {
  await seedOutline(page, TREE, {
    kv: {
      "account-prefs": [
        { key: "lunora-beta", value: { key: "lunora-beta", enabled: false } },
      ],
    },
  });
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible({ timeout: 15000 });
  const bible = page.getByRole("switch", { name: "Bible references" });
  const daily = page.getByRole("switch", { name: "Daily notes" });
  await expect(bible).toBeChecked();
  await expect(daily).toBeChecked();
  await expect(bible).toBeEnabled();
  await bible.click();
  await expect(bible).not.toBeChecked();
  await expect(bible).toBeEnabled();
  await page.reload();
  await expect(bible).toBeEnabled();
  await expect(bible).not.toBeChecked();
  await expect(daily).toBeChecked();
  await page.getByRole("button", { name: "Daily notes Details" }).click();
  await expect(
    page.getByText("Quick-add saves to the top level instead of Today."),
  ).toBeVisible();
  await daily.click();
  await expect(daily).toBeEnabled();
  await page.reload();
  await expect(daily).toBeEnabled();
  await expect(bible).not.toBeChecked();
  await expect(daily).not.toBeChecked();
});

test("disabled features leave source text intact in rows, titles, and quick-add", async ({
  page,
}) => {
  await seedOutline(page, TREE, {
    kv: {
      "account-prefs": [
        {
          key: "editor-feature:bible",
          value: { key: "editor-feature:bible", enabled: false },
        },
        {
          key: "editor-feature:daily",
          value: { key: "editor-feature:daily", enabled: false },
        },
      ],
    },
  });
  await page.goto("/");
  const row = page.locator('li[data-node-id="reflection"] .node-text');
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row).toHaveText("Read John 3:16 and [[2030-04-12]]");
  await expect(row.locator("[data-bible-ref], [data-date-link]")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Today's daily note" }),
  ).toHaveCount(0);
  await page.goto("/reflection");
  const title = page.locator(".zoomed-title-text");
  await expect(title).toHaveText("Read John 3:16 and [[2030-04-12]]");
  await expect(title.locator("[data-bible-ref], [data-date-link]")).toHaveCount(
    0,
  );
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await page.keyboard.press("q");
  await expect(
    page.getByRole("dialog", { name: "Quick add", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-quick-add-dest]")).toHaveAttribute(
    "data-quick-add-dest",
    "Top level",
  );
  const capture = page.locator(".quick-add-editor [contenteditable]");
  const saved = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/nodes",
  );
  await capture.fill("John 3:16 [[2030-04-12]]");
  await expect(
    capture.locator("[data-bible-ref], [data-date-link]"),
  ).toHaveCount(0);
  await page.keyboard.press("Enter");
  const request = await saved;
  const inserted = request
    .postDataJSON()
    .ops.find((op: { op: string }) => op.op === "insert");
  expect(inserted.value.parentId).toBeNull();
  await expect(
    page.getByRole("dialog", { name: "Quick add", exact: true }),
  ).not.toBeVisible();
});

test("today waits for account preferences and creates nothing when Daily is off", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.route(
    (url) =>
      url.pathname === "/api/kv" &&
      url.searchParams.get("collection") === "account-prefs",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        json: [{ key: "editor-feature:daily", enabled: false }],
      });
    },
  );
  const writes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() !== "GET" &&
      (url.pathname === "/api/nodes" ||
        (url.pathname === "/api/kv" &&
          url.searchParams.get("collection") === "daily-index"))
    )
      writes.push(request.url());
  });
  await page.goto("/today");
  await expect(page).toHaveURL(/\/$/, { timeout: 15000 });
  await expect(
    page.getByText("Daily notes is off", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('li[data-node-id="reflection"] .node-text'),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("focus refresh changes decoration in place and preserves local text and caret", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/reflection");
  const title = page.locator(".zoomed-title-text");
  await expect(title.locator("[data-bible-ref]")).toHaveCount(1, {
    timeout: 15000,
  });
  await expect(title.locator("[data-date-link]")).toHaveCount(1);
  await title.evaluate((el) => {
    // SAFETY: .zoomed-title-text is the editor's HTML span.
    (el as HTMLElement).focus();
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type("X");
  const setRemote = async (enabled: boolean) => {
    await page.evaluate(async (on) => {
      await fetch("/api/kv?collection=account-prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: ["bible", "daily"].map((feature) => ({
            key: `editor-feature:${feature}`,
            value: { key: `editor-feature:${feature}`, enabled: on },
          })),
        }),
      });
      window.dispatchEvent(new Event("focus"));
    }, enabled);
  };
  await setRemote(false);
  await expect(title).toHaveText("XRead John 3:16 and [[2030-04-12]]");
  await expect(title.locator("[data-bible-ref], [data-date-link]")).toHaveCount(
    0,
  );
  await expect(page).toHaveURL(/\/reflection$/);
  expect(
    await title.evaluate((el) => {
      const selection = window.getSelection()!;
      const prefix = document.createRange();
      prefix.selectNodeContents(el);
      prefix.setEnd(selection.anchorNode!, selection.anchorOffset);
      return {
        focused: document.activeElement === el,
        prefix: prefix.toString(),
      };
    }),
  ).toEqual({ focused: true, prefix: "X" });
  await expect(
    page.getByRole("button", { name: "Today's daily note" }),
  ).toHaveCount(0);
  await setRemote(true);
  await expect(title.locator("[data-bible-ref]")).toHaveCount(1);
  await expect(title.locator("[data-date-link]")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Today's daily note" }),
  ).toBeVisible();
  await title.fill("[[today");
  await expect(page.getByRole("listbox")).toBeVisible();
  await setRemote(false);
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("remote Bible disable dismisses an open passage editor without changing the note", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/");
  const row = page.locator('li[data-node-id="reflection"] .node-text');
  const chip = row.locator("[data-bible-ref]");
  await expect(chip).toBeVisible({ timeout: 15000 });
  await chip.click({ button: "right" });
  const dialog = page.getByRole("dialog", { name: "Edit Bible reference" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Passage" }).fill("Romans 8:1");
  for (const enabled of [false, true]) {
    await page.evaluate(async (on) => {
      await fetch("/api/kv?collection=account-prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              key: "editor-feature:bible",
              value: { key: "editor-feature:bible", enabled: on },
            },
          ],
        }),
      });
      window.dispatchEvent(new Event("focus"));
    }, enabled);
    await expect(chip).toHaveCount(enabled ? 1 : 0);
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText("John 3:16");
    await expect(row).not.toContainText("Romans 8:1");
  }
  await expect(page).toHaveURL(/\/$/);
});

test("Daily off removes daily slash commands, date suggestions, and command-center navigation", async ({
  page,
}) => {
  await seedOutline(page, TREE, {
    kv: {
      "account-prefs": [
        {
          key: "editor-feature:daily",
          value: { key: "editor-feature:daily", enabled: false },
        },
      ],
    },
  });
  await page.goto("/");
  const row = page.locator('li[data-node-id="reflection"] .node-text');
  await expect(
    page.getByRole("button", { name: "Today's daily note" }),
  ).toHaveCount(0);
  await expect(row.locator("[data-date-link]")).toHaveCount(0);
  await row.fill("/today");
  await expect(page.getByRole("option", { name: /Send to Today/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("option", { name: /Mirror to Today/ }),
  ).toHaveCount(0);
  await row.fill("[[today");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row.focus();
  await page.keyboard.press(
    `${process.platform === "darwin" ? "Meta" : "Control"}+k`,
  );
  await page.getByRole("combobox").fill("today");
  await expect(page.getByRole("option", { name: /Go to Today/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole("option", { name: /Send to Today/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("option", { name: /Mirror to Today/ }),
  ).toHaveCount(0);
  await page.getByRole("combobox").fill("quick add");
  await expect(page.getByRole("option", { name: /Quick add/ })).toContainText(
    "top level",
  );
});

test("a failed save restores the previous switch and does not change the other feature", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.route(
    (url) =>
      url.pathname === "/api/kv" &&
      url.searchParams.get("collection") === "account-prefs",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 400, json: { error: "Rejected save" } })
        : route.fallback(),
  );
  await page.goto("/settings");
  const bible = page.getByRole("switch", { name: "Bible references" });
  const daily = page.getByRole("switch", { name: "Daily notes" });
  await expect(bible).toBeEnabled({ timeout: 15000 });
  await bible.click();
  await expect(
    page.getByText(
      "Couldn't save bible references. Your previous setting was restored.",
    ),
  ).toBeVisible();
  await expect(bible).toBeEnabled();
  await expect(bible).toBeChecked();
  await expect(daily).toBeChecked();
  await page.reload();
  await expect(bible).toBeEnabled();
  await expect(bible).toBeChecked();
});

test("malformed preferences keep switches unavailable until a successful retry", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  let invalid = true;
  await page.route(
    (url) =>
      url.pathname === "/api/kv" &&
      url.searchParams.get("collection") === "account-prefs",
    (route) =>
      route.fulfill({
        json: [
          { key: "editor-feature:daily", enabled: invalid ? "false" : false },
        ],
      }),
  );
  await page.goto("/settings");
  const daily = page.getByRole("switch", { name: "Daily notes" });
  await expect(
    page.getByText("Couldn't load your feature settings.", { exact: false }),
  ).toBeVisible({ timeout: 15000 });
  await expect(daily).toBeDisabled();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByText("Couldn't load your feature settings.", { exact: true }),
  ).toBeVisible();
  await expect(daily).toBeDisabled();
  invalid = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(daily).toBeEnabled();
  await expect(daily).not.toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Bible references" }),
  ).toBeChecked();
});

test("quick-add waits for preferences before choosing a default destination", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) =>
      url.pathname === "/api/kv" &&
      url.searchParams.get("collection") === "account-prefs",
    async (route) => {
      await gate;
      await route.fulfill({
        json: [{ key: "editor-feature:daily", enabled: false }],
      });
    },
  );
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="reflection"] .node-text'),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("button", { name: "Today's daily note" }),
  ).toHaveCount(0);
  const row = page.locator('li[data-node-id="reflection"] .node-text');
  await row.fill("[[today");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row.fill(TREE[0]!.text);
  await row.evaluate((el) => {
    if (el instanceof HTMLElement) el.blur();
  });
  await page.keyboard.press("q");
  await expect(
    page.getByRole("dialog", { name: "Quick add", exact: true }),
  ).toHaveCount(0);
  release();
  await expect(
    page.getByRole("dialog", { name: "Quick add", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-quick-add-dest]")).toHaveAttribute(
    "data-quick-add-dest",
    "Top level",
  );
});

test("Daily off preserves every scaffold deletion guard and existing note access", async ({
  page,
}) => {
  const scaffold = [
    { id: "container", parentId: null, prevSiblingId: null, text: "Daily" },
    { id: "year", parentId: "container", prevSiblingId: null, text: "2026" },
    { id: "month", parentId: "year", prevSiblingId: null, text: "October" },
    { id: "week", parentId: "month", prevSiblingId: null, text: "Week 40" },
    {
      id: "day",
      parentId: "week",
      prevSiblingId: null,
      text: "October 3, 2026",
    },
    { ...TREE[0]!, prevSiblingId: "container" },
  ];
  await seedOutline(page, scaffold, {
    kv: {
      "account-prefs": [
        {
          key: "editor-feature:daily",
          value: { key: "editor-feature:daily", enabled: false },
        },
      ],
      "daily-index": [
        "container",
        "2026",
        "2026-10",
        "2026-W40",
        "2026-10-03",
      ].map((key, i) => ({ key, value: { key, nodeId: scaffold[i]!.id } })),
    },
  });
  await page.goto("/");
  const plain = page.locator('li[data-node-id="reflection"] .node-text');
  await expect(plain).toContainText("[[2030-04-12]]", { timeout: 15000 });
  for (const id of ["container", "year", "month", "week"]) {
    const row = page.locator(`li[data-node-id="${id}"] .outline-row`);
    await expect(row.locator(".protected-lock")).toBeVisible();
    await row.locator(".node-text").click();
    await page.keyboard.press(
      `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+Backspace`,
    );
    await expect(row).toHaveClass(/node-rejected/);
    await expect(page.locator('li[data-node-id="day"]')).toBeVisible();
  }
  await plain.click();
  await page.keyboard.press(
    `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+Backspace`,
  );
  await expect(page.locator('li[data-node-id="reflection"]')).toHaveCount(0);
  await page.goto("/day");
  await expect(page.locator(".zoomed-title-text")).toHaveText(
    "October 3, 2026",
  );
  await expect(page.locator("[data-daily-date], [data-date-link]")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Today's daily note" }),
  ).toHaveCount(0);
});

test("a focus change updates an untouched quick-add destination without creating notes", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="reflection"] .node-text'),
  ).toBeVisible({ timeout: 15000 });
  await page.keyboard.press("q");
  const destination = page.locator("[data-quick-add-dest]");
  await expect(destination).toHaveAttribute("data-quick-add-dest", "Today");
  const writes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() !== "GET" &&
      (url.pathname === "/api/nodes" ||
        (url.pathname === "/api/kv" &&
          url.searchParams.get("collection") === "daily-index"))
    )
      writes.push(request.url());
  });
  await page.evaluate(async () => {
    await fetch("/api/kv?collection=account-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: [
          {
            key: "editor-feature:daily",
            value: { key: "editor-feature:daily", enabled: false },
          },
        ],
      }),
    });
    window.dispatchEvent(new Event("focus"));
  });
  await expect(destination).toHaveAttribute("data-quick-add-dest", "Top level");
  expect(writes).toEqual([]);
  const saved = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/nodes",
  );
  await page
    .locator(".quick-add-editor [contenteditable]")
    .fill("Capture after switching off Daily");
  const inserted = (await saved)
    .postDataJSON()
    .ops.find((op: { op: string }) => op.op === "insert");
  expect(inserted.value.parentId).toBeNull();
});

for (const surface of ["Move", "Quick add"] as const) {
  test(`${surface} refreshes Daily aliases without losing access to ordinary note titles`, async ({
    page,
  }) => {
    const key = localDateKey();
    await seedOutline(
      page,
      [
        ...TREE,
        {
          id: "mapped-day",
          parentId: null,
          prevSiblingId: "reflection",
          text: "Planning record",
        },
      ],
      {
        kv: {
          "daily-index": [{ key, value: { key, nodeId: "mapped-day" } }],
        },
      },
    );
    await page.goto("/");
    const row = page.locator('li[data-node-id="reflection"] .node-text');
    await expect(row).toBeVisible({ timeout: 15000 });
    if (surface === "Move") {
      await row.fill("/move");
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("dialog", { name: "Move node" }),
      ).toBeVisible();
    } else {
      await page.keyboard.press("q");
      await page.locator("[data-quick-add-dest]").click();
    }
    const query = page.getByRole("combobox");
    await query.fill("today");
    const note = page.getByRole("option", { name: /Planning record/ });
    await expect(note).toBeVisible();
    await page.evaluate(async () => {
      await fetch("/api/kv?collection=account-prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              key: "editor-feature:daily",
              value: { key: "editor-feature:daily", enabled: false },
            },
          ],
        }),
      });
      window.dispatchEvent(new Event("focus"));
    });
    await expect(note).toHaveCount(0);
    await query.fill("Planning record");
    await expect(note).toBeVisible();
    await expect(note).not.toContainText("Today");
  });
}
