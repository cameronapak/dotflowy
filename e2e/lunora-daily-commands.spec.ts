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
 * The last describe covers the same root cause in the editor's post-move filter
 * recheck (`OutlineEditor.tsx`), which read that same starved collection and so
 * toasted "hidden by the current filter" on every filtered drag under Lunora.
 *
 * Run: `bunx playwright test e2e/lunora-daily-commands.spec.ts`
 */

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

/**
 * Append-only ledger of every toast that ever mounted.
 *
 * `expect(toastLocator).toHaveCount(0)` is NOT a "no toast" assertion: it
 * RETRIES, so it goes green the moment a toast that really did fire
 * auto-dismisses four seconds later. The pre-fix build passed exactly that way.
 * A toast is a transient, so pin it with a record instead of a live query.
 *
 * Must be installed BEFORE `page.goto` -- `addInitScript` runs per navigation.
 */
async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __e2eToasts: string[] }).__e2eToasts = seen;
    const scan = () => {
      for (const el of document.querySelectorAll("[data-sonner-toast]")) {
        const t = (el as HTMLElement).innerText.trim();
        if (t && !seen.includes(t)) seen.push(t);
      }
    };
    const start = () => {
      scan();
      new MutationObserver(scan).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  });
}

const toastLedger = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __e2eToasts?: string[] }).__e2eToasts ?? [],
  );

/** Assert no toast whose text matches `re` has EVER mounted. */
async function expectNoToast(page: Page, re: RegExp): Promise<void> {
  expect((await toastLedger(page)).filter((t) => re.test(t))).toEqual([]);
}

/** Put the caret at the end of a bullet through the Selection API. `.click()`
 *  can land on a chip or past the text, and macOS Chromium's Home/End/arrow
 *  keys are unreliable in a contentEditable (AGENTS.md). */
async function caretAtEnd(page: Page, id: string): Promise<void> {
  await text(page, id).evaluate((el) => {
    (el as HTMLElement).focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await expect(text(page, id)).toBeFocused();
}

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
  await recordToasts(page);
  await page.goto("/");
  await expect(text(page, "a")).toBeVisible({ timeout: 15_000 });
  // The badge only renders once the daily index has synced, which is what makes
  // the seeded node today's note rather than a bullet with a date-shaped title.
  await expect(
    page.locator(`li[data-node-id="${TODAY_ID}"] [data-daily-today]`),
  ).toBeAttached({ timeout: 15_000 });
}

/** Focus a bullet and open the `/` menu. `detectSlash` reads the source text
 *  BEFORE the caret, so the caret has to be at the end and the leading space is
 *  what makes the `/` a command rather than part of a word. */
async function openSlash(page: Page, id: string, query: string): Promise<void> {
  await caretAtEnd(page, id);
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

    await expect(page.getByText("Mirrored to Today")).toBeVisible({
      timeout: 15_000,
    });
    // The bug's signature was this toast firing every time. Read the ledger,
    // not a live locator -- see recordToasts.
    await expectNoToast(page, /Can't mirror that into Today/);

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

    await caretAtEnd(page, "a");
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
    await caretAtEnd(page, "b");
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

  /**
   * The day-CREATION branch: no day note, no daily index, so `getOrCreateDay`
   * has to run `materializeNewDayLunora` before the mirror can land.
   *
   * This is the first daily command of a new day, which is the most common way
   * a user meets #325. The other tests seed the day, so without this one the
   * whole `claimDailyMapping` -> `materializeDailyNodes` -> post-persist
   * `hasNode` sequence is untested on the Lunora path.
   */
  test("Mirror to Today creates the day note when none exists yet", async ({
    page,
  }) => {
    const bare: SeedNode[] = [
      { id: "a", parentId: null, prevSiblingId: null, text: "Alpha" },
      { id: "b", parentId: null, prevSiblingId: "a", text: "Bravo" },
    ];
    await seedOutlineLunora(page, bare);
    await recordToasts(page);
    await page.goto("/");
    await expect(text(page, "a")).toBeVisible({ timeout: 15_000 });

    await openSlash(page, "a", "mirror");
    await page.getByRole("option", { name: /Mirror to Today/ }).click();

    await expect(page.getByText("Mirrored to Today")).toBeVisible({
      timeout: 15_000,
    });
    // getOrCreateDay returning null is the failure this pins: the command bails
    // before it ever reaches mirrorNode, so the user gets a generic toast.
    await expectNoToast(page, /Couldn't open today's daily note/);
    await expectNoToast(page, /Can't mirror that into Today/);

    // The scaffold materialized: Daily > YYYY > Month > Week > today.
    const day = page.locator(`li:has(> .outline-row [data-daily-today])`);
    await expect(day).toHaveCount(1);
    const mirror = page.locator('li[data-mirror="instance"]');
    await expect(mirror).toHaveCount(1);
    await expect(mirror.locator("> .outline-row .node-text")).toContainText(
      "Alpha",
    );
    // The mirror is a child of the day note, not a stray top-level bullet.
    const dayId = await day.getAttribute("data-node-id");
    await expect(mirror).toHaveAttribute("data-parent-id", dayId!);
  });
});

// --- the editor's post-move filter recheck ----------------------------------

// Pointer simulation, `settle()` and `rowBox()` are borrowed from
// e2e/drag-filtered.spec.ts, whose own tests carry `test.skip(isE2eLunora())`
// because they await the classic /api/nodes POST.

const rowBox = async (page: Page, id: string) => {
  const box = await page.locator(`li[data-node-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`row ${id} has no box`);
  return box;
};

/** Let the window virtualizer flush its row measurements. The drag projects its
 *  drop gaps from those measurements, not the DOM, so an unmeasured row rect
 *  shifts the projection by a row (ADR 0019). */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );

/** The rendered order of mounted rows, by the virtualizer's flat index. */
const visibleOrder = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("li[data-node-id]"))
      .map((li) => ({
        id: (li as HTMLElement).dataset.nodeId!,
        index: Number((li as HTMLElement).dataset.index),
      }))
      .sort((x, y) => x.index - y.index)
      .map((r) => r.id),
  );

test.describe("filtered drag recheck (Lunora flag ON)", () => {
  test("a drag that lands the row still visible does not toast", async ({
    page,
  }) => {
    // Real top-level order: S1, S2, V1, H1, H2, V2, X. Under #go the untagged
    // H1/H2 are pruned, leaving S1, S2, V1, V2, X. The S1/S2 spacers keep the
    // target V1/V2 gap below the top-edge auto-scroll band.
    const tree: SeedNode[] = [
      { id: "S1", parentId: null, prevSiblingId: null, text: "spacer1 #go" },
      { id: "S2", parentId: null, prevSiblingId: "S1", text: "spacer2 #go" },
      { id: "V1", parentId: null, prevSiblingId: "S2", text: "visible1 #go" },
      { id: "H1", parentId: null, prevSiblingId: "V1", text: "hidden1" },
      { id: "H2", parentId: null, prevSiblingId: "H1", text: "hidden2" },
      { id: "V2", parentId: null, prevSiblingId: "H2", text: "visible2 #go" },
      { id: "X", parentId: null, prevSiblingId: "V2", text: "mover #go" },
    ];
    await seedOutlineLunora(page, tree);
    await recordToasts(page);
    await page.goto(`/?q=${encodeURIComponent("#go")}`);
    await expect(row(page, "V1")).toBeVisible({ timeout: 15_000 });
    // Sanity: the untagged siblings really are pruned, so a filter IS active
    // and the post-move recheck really does run.
    await expect(row(page, "H1")).toHaveCount(0);
    await expect(row(page, "H2")).toHaveCount(0);
    await settle(page);

    const bullet = page.locator('li[data-node-id="X"] .bullet');
    const from = await bullet.boundingBox();
    if (!from) throw new Error("no bullet box");
    const startX = from.x + from.width / 2;
    const startY = from.y + from.height / 2;

    // Drop in the gap between the two VISIBLE rows V1 and V2, at depth 0. X
    // stays a top-level `#go` match, so it is still in the filter's visible set
    // and the recheck must stay quiet. Aim a quarter-row into V2 so a sub-pixel
    // wobble can't flip the gap one row up.
    const v2 = await rowBox(page, "V2");
    const dropY = v2.y + Math.min(8, v2.height / 4);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 10, startY + 10, { steps: 3 });
    await page.mouse.move(startX, dropY, { steps: 5 });
    await page.mouse.up();

    // The move landed: X now sits right after the visible predecessor V1.
    await expect
      .poll(() => visibleOrder(page), { timeout: 15_000 })
      .toEqual(["S1", "S2", "V1", "X", "V2"]);

    // Give a spurious toast a bounded window to mount ...
    await page
      .locator("[data-sonner-toast]")
      .first()
      .waitFor({ state: "attached", timeout: 2_000 })
      .catch(() => {});
    // ... then read the ledger. Before the fix the recheck built its index from
    // the ready-and-empty `nodesCollection`, so `visibleIds` held nothing and
    // this toast fired on every filtered drag.
    expect((await toastLedger(page)).join(" | ")).not.toContain(
      "hidden by the current filter",
    );
    // X is a match, so it stays rendered under the filter.
    await expect(row(page, "X")).toBeVisible();
  });
});
