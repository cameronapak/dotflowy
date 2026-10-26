import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  text,
  type ApiNode,
  type SeedNode,
} from "./fixtures";

const TREE: SeedNode[] = [
  { id: "work", parentId: null, prevSiblingId: null, text: "Writing" },
  {
    id: "draft",
    parentId: "work",
    prevSiblingId: null,
    text: "Finish the draft ||private detail||",
    isTask: true,
  },
  {
    id: "child",
    parentId: "draft",
    prevSiblingId: null,
    text: "Existing notes",
  },
  { id: "other", parentId: null, prevSiblingId: "work", text: "Other work" },
  {
    id: "mirror",
    parentId: null,
    prevSiblingId: "other",
    text: "",
    mirrorOf: "draft",
  },
  {
    id: "locked",
    parentId: null,
    prevSiblingId: "mirror",
    text: "Locked task",
    isTask: true,
    locked: true,
  },
];
const band = (page: Page) =>
  page.getByRole("region", { name: "Focus session", exact: true });
async function stored(page: Page): Promise<ApiNode[]> {
  return page.evaluate(async () => (await fetch("/api/nodes")).json());
}

async function picker(page: Page, id = "draft") {
  await placeCaret(text(page, id), "end");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder(/Search nodes and actions/).fill("Focus session");
  await page.getByRole("option", { name: /Focus session…/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Focus session" }),
  ).toBeVisible();
}

test("start preserves the view, away and Return land the caret, overtime Done reflects under the task", async ({
  page,
}) => {
  await page.clock.install();
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "draft" });
  await picker(page);
  await page.getByRole("button", { name: "15 min", exact: true }).click();
  await page
    .getByRole("button", { name: "Start focus session", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(band(page)).toContainText("Now");
  await expect(band(page)).toContainText("Finish the draft [spoiler]");
  await expect(
    page
      .locator('li[data-node-id="draft"]')
      .getByRole("img", { name: "Active focus session" }),
  ).toHaveCount(1);
  await page.locator('li[data-node-id="other"] .bullet-dot').click();
  await expect(band(page)).toContainText("You set out to");
  await band(page).getByRole("button", { name: "Return", exact: true }).click();
  await expect(page).toHaveURL(/\/draft$/);
  const title = page.getByLabel("Title", { exact: true });
  await expect(title).toBeFocused();
  await expect
    .poll(() =>
      title.evaluate((el) => {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return false;
        const range = selection.getRangeAt(0).cloneRange();
        range.selectNodeContents(el);
        range.setStart(selection.anchorNode!, selection.anchorOffset);
        return range.toString().length === 0;
      }),
    )
    .toBe(true);
  await page.clock.fastForward(16 * 60_000);
  await expect(
    band(page).getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  await expect(band(page).getByLabel("Focus time remaining")).toContainText(
    "+",
  );
  await band(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await stored(page)).find((node) => node.id === "draft")?.completed,
    )
    .toBe(true);
  await band(page)
    .getByRole("textbox", { name: "How did it go?" })
    .fill("Finished the introduction");
  await band(page)
    .getByRole("textbox", { name: "How did it go?" })
    .press("Enter");
  await expect(band(page)).toHaveCount(0);
  const reflection = (await stored(page)).find((node) =>
    node.text.endsWith(": Finished the introduction"),
  );
  expect(reflection?.parentId).toBe("draft");
  expect(reflection?.prevSiblingId).toBe("child");
  expect(reflection?.isTask).toBe(false);
});

test("pause, replacement, Let go, mirror reflection, external completion and deletion", async ({
  page,
}) => {
  await page.clock.install();
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "draft" });
  await picker(page);
  await page
    .getByRole("button", { name: "Start focus session", exact: true })
    .click();
  await band(page)
    .getByRole("button", { name: "Pause focus session", exact: true })
    .click();
  const time = await band(page)
    .getByLabel("Focus time remaining")
    .textContent();
  await page.clock.fastForward(5 * 60_000);
  await expect(band(page).getByLabel("Focus time remaining")).toHaveText(time!);
  await picker(page, "mirror");
  await expect(page.getByRole("dialog")).toContainText("Replaces:");
  await page
    .getByRole("button", { name: "Start focus session", exact: true })
    .click();
  await page.clock.fastForward(61 * 60_000);
  await band(page).getByRole("button", { name: "Let go", exact: true }).click();
  await band(page)
    .getByRole("textbox", { name: "How did it go?" })
    .fill("Need another pass");
  await band(page)
    .getByRole("textbox", { name: "How did it go?" })
    .press("Enter");
  await expect(band(page)).toHaveCount(0);
  expect(
    (await stored(page)).find((node) => node.id === "draft")?.completed,
  ).toBe(false);
  expect(
    (await stored(page)).find((node) =>
      node.text.endsWith(": Need another pass"),
    )?.parentId,
  ).toBe("draft");
  await picker(page);
  await page
    .getByRole("button", { name: "Start focus session", exact: true })
    .click();
  await placeCaret(text(page, "draft"), "end");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(band(page)).toContainText("How did it go?");
  await band(page).getByRole("button", { name: "Skip", exact: true }).click();
  await picker(page, "other");
  await page
    .getByRole("button", { name: "Start focus session", exact: true })
    .click();
  await placeCaret(text(page, "other"), "end");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder(/Search nodes and actions/).fill("Delete");
  await page.getByRole("option", { name: /^Delete/ }).click();
  await expect(band(page)).toHaveCount(0);
  await expect(
    page.getByText("Focus session ended because the node was deleted."),
  ).toBeVisible();
});

test("Pomodoro takes automatic breaks, waits for each round and excludes breaks from reflection", async ({
  page,
}) => {
  await page.clock.install();
  await seedOutline(page, TREE, {
    kv: {
      "account-prefs": [
        {
          key: "focus:settings",
          value: {
            key: "focus:settings",
            settings: {
              focusMinutes: 2,
              breakMinutes: 1,
              longBreakMinutes: 3,
              rounds: 2,
              sounds: false,
            },
          },
        },
      ],
    },
  });
  await openSeededOutline(page, { anchorId: "draft" });
  await picker(page);
  await page.getByRole("button", { name: "Pomodoro", exact: true }).click();
  await page
    .getByRole("button", { name: "Start focus session", exact: true })
    .click();
  await page.clock.fastForward(2 * 60_000);
  await expect(band(page)).toHaveAttribute("data-focus-phase", "break");
  await page.clock.fastForward(4 * 60_000);
  await expect(band(page)).toHaveAttribute("data-focus-phase", "ready");
  await band(page)
    .getByRole("button", { name: "Start round 2", exact: true })
    .click();
  await page.clock.fastForward(2 * 60_000);
  await expect(band(page)).toHaveAttribute("data-focus-phase", "break");
  await expect(band(page).getByLabel("Focus time remaining")).toHaveText(
    "3:00",
  );
  await band(page).getByRole("button", { name: "Done", exact: true }).click();
  await band(page)
    .getByRole("textbox", { name: "How did it go?" })
    .fill("Two rounds");
  await band(page)
    .getByRole("textbox", { name: "How did it go?" })
    .press("Enter");
  await expect(band(page)).toHaveCount(0);
  expect(
    (await stored(page)).find((node) => node.text.endsWith(": Two rounds"))
      ?.text,
  ).toMatch(/, 4 min: Two rounds$/);
});

test("View actions target the page, hide at Home, and Locked Done cannot complete or reflect", async ({
  page,
}) => {
  await page.clock.install();
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "draft" });
  await page.getByRole("button", { name: "View options" }).click();
  await expect(page.getByRole("menu", { name: "View options" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Focus on this page…" }),
  ).toHaveCount(0);
  await page.getByRole("menu", { name: "View options" }).press("Escape");
  await expect(page.getByRole("menu", { name: "View options" })).toBeHidden();
  await page.locator('li[data-node-id="locked"] .bullet-dot').click();
  await page.getByRole("button", { name: "View options" }).click();
  await page.getByRole("menuitem", { name: "Focus on this page…" }).click();
  await expect(page.getByRole("dialog")).toContainText("Locked task");
  await page
    .getByRole("button", { name: "Start focus session", exact: true })
    .click();
  await page.clock.fastForward(61 * 60_000);
  await band(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(band(page)).toHaveCount(0);
  expect(
    (await stored(page)).find((node) => node.id === "locked")?.completed,
  ).toBe(false);
  await expect(
    page.getByText(/This node is Locked and could not be checked off/),
  ).toBeVisible();
});

test("slash start, remembered custom length, cross-tab pause, reload, extension and PiP reflection", async ({
  page,
}) => {
  await page.clock.install();
  const outline = await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "draft" });
  await placeCaret(text(page, "draft"), "end");
  await page.keyboard.type(" /focus");
  await page.getByRole("option", { name: /Focus session/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "Minutes", exact: true })
    .fill("1");
  await page
    .getByRole("button", { name: "Start focus session", exact: true })
    .click();
  await expect(text(page, "draft")).toHaveText(
    "Finish the draft ||private detail||",
  );

  const other = await page.context().newPage();
  await seedOutline(other, TREE);
  await openSeededOutline(other, { anchorId: "draft" });
  await expect(band(other)).toContainText("Finish the draft [spoiler]");
  await band(other)
    .getByRole("button", { name: "Pause focus session", exact: true })
    .click();
  await expect(band(page)).toContainText("Paused");
  await page.reload();
  // As on initial navigation, document load precedes the lazy editor and sync.
  // Give readiness the test budget before asserting the restored session state.
  await text(page, "draft").waitFor({ state: "visible" });
  await expect(band(page)).toContainText("Paused");
  await picker(page, "other");
  await expect(
    page.getByRole("spinbutton", { name: "Minutes", exact: true }),
  ).toHaveValue("1");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await band(page)
    .getByRole("button", { name: "Resume focus session", exact: true })
    .click();
  await page.clock.fastForward(61_000);
  await band(page).getByRole("button", { name: "+5 min", exact: true }).click();
  await expect(band(page).getByLabel("Focus time remaining")).toHaveText(
    "5:00",
  );

  await page.clock.runFor(1000);
  await page.evaluate(() => document.fonts.ready);
  const popupPromise = page.context().waitForEvent("page");
  await band(page)
    .getByRole("button", { name: "Pop out focus session", exact: true })
    .click();
  const popup = await popupPromise;
  await popup.setViewportSize({ width: 300, height: 180 });
  const card = popup.getByRole("region", { name: "Focus card" });
  await expect(card).toContainText("Writing");
  await expect(card).toContainText("Finish the draft [spoiler]");
  await expect(card).not.toContainText("private detail");
  await expect
    .poll(() =>
      popup.evaluate(
        () =>
          document.fonts.status === "loaded" &&
          [...document.fonts].some(
            (face) =>
              face.family === "Geist Variable" && face.status === "loaded",
          ),
      ),
    )
    .toBe(true);
  await card
    .getByRole("button", { name: "Pause focus session", exact: true })
    .click();
  await expect(band(page)).toContainText("Paused");
  await page.getByRole("button", { name: "Account and help" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "Focus minutes", exact: true })
    .fill("3");
  await page
    .getByRole("button", { name: "Save Pomodoro settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save Pomodoro settings", exact: true }),
  ).toBeEnabled();
  await page.getByRole("switch", { name: "Sounds", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Sounds", exact: true }),
  ).not.toBeChecked();
  await card
    .getByRole("button", { name: "Back to focus", exact: true })
    .click();
  await expect(page).toHaveURL(/\/draft$/);
  await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
  await card
    .getByRole("button", { name: "Resume focus session", exact: true })
    .click();
  await page.clock.fastForward(301_000);
  await card.getByRole("button", { name: "Done", exact: true }).click();
  await card
    .getByRole("textbox", { name: "How did it go?" })
    .fill("Saved from the floating card");
  await card.getByRole("textbox", { name: "How did it go?" }).press("Enter");
  await expect(band(page)).toHaveCount(0);
  expect(
    (await stored(page)).find((node) =>
      node.text.endsWith(": Saved from the floating card"),
    )?.parentId,
  ).toBe("draft");
  await picker(page, "child");
  await page
    .getByRole("button", { name: "Start focus session", exact: true })
    .click();
  await page.getByRole("button", { name: "Account and help" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await outline.injectExternalChange([{ op: "delete", key: "child" }]);
  await expect(card).toHaveCount(0);
  await expect(
    popup.getByText("No focus session", { exact: true }),
  ).toBeVisible();
  await popup.close();
  await other.close();
  await page.goto("/settings");
  await expect(
    page.getByRole("spinbutton", { name: "Focus minutes", exact: true }),
  ).toHaveValue("3");
  await expect(
    page.getByRole("switch", { name: "Sounds", exact: true }),
  ).not.toBeChecked();
});
