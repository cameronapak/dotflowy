import { expect, test, type Page } from "@playwright/test";

import {
  dayKeyToScaffoldChain,
  localDateKey,
  scaffoldLabel,
} from "../src/data/date-links";
import {
  CONTAINER_KEY,
  DAILY_CONTAINER_TEXT,
  formatDayText,
} from "../src/plugins/daily/daily-index";
import { seedOutlineLunora, type SeedNode } from "./fixtures";

/**
 * Daily `/` commands with the Lunora flag ON (ADR 0058).
 *
 * The four call sites in `src/plugins/daily/index.tsx` used to build their tree
 * index from `nodesCollection.toArray`, which is ready-and-EMPTY for the whole
 * session while the flag is on. That empty index failed `mirrorNode`'s first
 * guard (Mirror to Today always toasted an error) and made `capture()` store a
 * zero-node snapshot (undo replayed it as delete-everything). Both are pinned
 * here; both fail without the `getLiveNodes()` fix.
 *
 * Today's note is SEEDED, not created by the command. A returning user's day
 * already exists, which is the state the reported bug was hit in. Creating it
 * in-test would instead hit a separate Lunora race in `materializeNewDayLunora`
 * (`isPersisted` resolves before the shape poke applies the rows, so the
 * post-persist `hasNode` check fails and `getOrCreateDay` returns null).
 *
 * Run: `bunx playwright test e2e/lunora-daily-commands.spec.ts`
 */

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

const DAY_KEY = localDateKey();
const CHAIN = dayKeyToScaffoldChain(DAY_KEY)!;

const TODAY_ID = "today-day";

/** Three plain top-level bullets, then the full nested daily scaffold:
 *  Daily > YYYY > Month > Week > Today. Nested (not flat) so the one-time
 *  flat->nested migration never runs during a test. */
const TREE: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "Alpha" },
  { id: "b", parentId: null, prevSiblingId: "a", text: "Bravo" },
  { id: "c", parentId: null, prevSiblingId: "b", text: "Charlie" },
  {
    id: "daily-container",
    parentId: null,
    prevSiblingId: "c",
    text: DAILY_CONTAINER_TEXT,
  },
  {
    id: "daily-year",
    parentId: "daily-container",
    prevSiblingId: null,
    text: scaffoldLabel(CHAIN.yearKey),
  },
  {
    id: "daily-month",
    parentId: "daily-year",
    prevSiblingId: null,
    text: scaffoldLabel(CHAIN.monthKey),
  },
  {
    id: "daily-week",
    parentId: "daily-month",
    prevSiblingId: null,
    text: scaffoldLabel(CHAIN.weekKey),
  },
  {
    id: TODAY_ID,
    parentId: "daily-week",
    prevSiblingId: null,
    text: formatDayText(DAY_KEY),
  },
];

/** The daily index rows that make the seeded nodes the AUTHORITATIVE scaffold.
 *  Without them `claimScaffoldNode` mints a second Daily tree beside this one. */
const DAILY_KV = {
  "daily-index": [
    {
      key: CONTAINER_KEY,
      value: { key: CONTAINER_KEY, nodeId: "daily-container" },
    },
    {
      key: CHAIN.yearKey,
      value: { key: CHAIN.yearKey, nodeId: "daily-year" },
    },
    {
      key: CHAIN.monthKey,
      value: { key: CHAIN.monthKey, nodeId: "daily-month" },
    },
    {
      key: CHAIN.weekKey,
      value: { key: CHAIN.weekKey, nodeId: "daily-week" },
    },
    { key: DAY_KEY, value: { key: DAY_KEY, nodeId: TODAY_ID } },
  ],
};

async function load(page: Page): Promise<void> {
  await seedOutlineLunora(page, TREE, { kv: DAILY_KV });
  await page.goto("/");
  await expect(text(page, "a")).toBeVisible({ timeout: 15_000 });
  // The badge only renders once the daily index has synced, which is what makes
  // the seeded node today's note rather than a bullet with a date-shaped title.
  await expect(
    page.locator(`li[data-node-id="${TODAY_ID}"] [data-daily-today]`),
  ).toBeAttached({ timeout: 15_000 });
}

/** Focus a bullet and open the `/` menu. The leading space makes `detectSlash`
 *  fire (same shape as move-dialog.spec / daily-notes.spec). */
async function openSlash(page: Page, id: string, query: string): Promise<void> {
  await text(page, id).click();
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(` /${query}`);
  await expect(page.getByRole("listbox")).toBeVisible();
}

test.describe("daily commands (Lunora flag ON)", () => {
  test("Mirror to Today creates a mirror under the day note", async ({
    page,
  }) => {
    await load(page);

    await openSlash(page, "a", "mirror");
    await page.getByRole("option", { name: /Mirror to Today/ }).click();

    // The bug's signature was this toast firing every time.
    await expect(page.getByText("Can't mirror that into Today.")).toHaveCount(
      0,
    );
    await expect(page.getByText("Mirrored to Today")).toBeVisible({
      timeout: 15_000,
    });

    const mirror = page.locator('li[data-mirror="instance"]');
    await expect(mirror).toHaveCount(1);
    await expect(mirror).toHaveAttribute("data-parent-id", TODAY_ID);
    await expect(mirror.locator("> .outline-row .node-text")).toContainText(
      "Alpha",
    );
    // The source stays where it was -- a mirror copies, it doesn't move.
    await expect(row(page, "a")).not.toHaveAttribute("data-parent-id", /.+/);
  });

  test("multi-select Mirror to Today creates one mirror per selected node", async ({
    page,
  }) => {
    await load(page);

    await text(page, "a").click();
    await expect(text(page, "a")).toBeFocused();
    await page.keyboard.press("Shift+ArrowDown"); // enter selection -> [a]
    await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    await menu.getByRole("option", { name: /Mirror to Today/ }).click();

    await expect(page.getByText("Mirrored 2 to Today")).toBeVisible({
      timeout: 15_000,
    });

    const mirrors = page.locator('li[data-mirror="instance"]');
    await expect(mirrors).toHaveCount(2);
    await expect(mirrors.first()).toHaveAttribute("data-parent-id", TODAY_ID);
    await expect(mirrors.last()).toHaveAttribute("data-parent-id", TODAY_ID);
  });

  test("Send to Today moves the node under the day note", async ({ page }) => {
    await load(page);

    await openSlash(page, "a", "today");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Moved to Today")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator(`li[data-node-id="a"][data-parent-id="${TODAY_ID}"]`),
    ).toBeVisible();
  });

  test("undo after Send to Today restores the move without deleting siblings", async ({
    page,
  }) => {
    await load(page);

    await openSlash(page, "a", "today");
    await page.keyboard.press("Enter");
    await expect(
      page.locator(`li[data-node-id="a"][data-parent-id="${TODAY_ID}"]`),
    ).toBeVisible({ timeout: 15_000 });

    // Undo from an untouched sibling. A zero-node capture would make this
    // restore classify EVERY live node as a delete and wipe the outline.
    await text(page, "b").click();
    await expect(text(page, "b")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");

    // Alpha is back at the top level ...
    await expect(
      page.locator('li[data-node-id="a"]:not([data-parent-id])'),
    ).toBeVisible({ timeout: 15_000 });
    // ... and the nodes the command never touched are still there.
    await expect(text(page, "b")).toBeVisible();
    await expect(text(page, "c")).toBeVisible();
    // The day note survives too.
    await expect(row(page, TODAY_ID)).toHaveCount(1);
  });
});
