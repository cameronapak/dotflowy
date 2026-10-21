import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  seedOutline,
  STANDARD_TREE,
  type SeedNode,
} from "./fixtures";

// A fixed Calendar week far from "now", so month/year/range assertions are
// stable whatever day the suite runs on.
const DAY = "2030-06-12";
const WEEK = "week:2030-06-10";
const MONTH_YEAR = "June 2030";
const WEEK_RANGE = "Jun 10–16";
const NEXT_WEEK_RANGE = "Jun 17–23";

const dailyIndexKv = (rows: { key: string; nodeId: string }[]) => ({
  "daily-index": rows.map((r) => ({ key: r.key, value: r })),
});

// Client navigation (pushState + popstate) zooms without a full reload, so the
// seedOutline route mocks keep serving the same in-memory store (a reload would
// re-run the collection's first sync). Mirrors daily-notes.spec's helper.
async function clientNavigate(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

// This spec covers the strip's own behavior (ADR 0054), which holds with the
// Day stream off. Inside the stream a pill scrolls instead of navigating; the
// day-stream spec covers that (ADR 0070).
const DAY_STREAM_OFF = {
  key: "daily:day-stream",
  value: { key: "daily:day-stream", enabled: false },
};

async function load(
  page: Page,
  tree: SeedNode[],
  opts: Parameters<typeof seedOutline>[2],
) {
  await seedOutline(page, tree, {
    ...opts,
    kv: {
      ...opts?.kv,
      "account-prefs": [...(opts?.kv?.["account-prefs"] ?? []), DAY_STREAM_OFF],
    },
  });
  await openSeededOutline(page, { anchorId: "alpha" });
}

const strip = (page: Page) =>
  page.getByRole("navigation", { name: "Week calendar" });
const pill = (page: Page, key: string) =>
  strip(page).locator(`[data-day-key="${key}"]`);

async function dragNodeToDay(page: Page, nodeId: string, key: string) {
  const bullet = page.locator(`li[data-node-id="${nodeId}"] .bullet`);
  const target = pill(page, key);
  await expect(bullet).toBeVisible();
  await expect(target).toBeVisible();
  const bulletBox = await bullet.boundingBox();
  const targetBox = await target.boundingBox();
  if (!bulletBox || !targetBox)
    throw new Error("drag endpoints are not visible");

  const startX = bulletBox.x + bulletBox.width / 2;
  const startY = bulletBox.y + bulletBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY + 10, { steps: 3 });
  await page.mouse.move(targetX, targetY, { steps: 8 });
}

test("shows on a day node, and NOT on a non-daily node or a week scaffold node", async ({
  page,
}) => {
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "the-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "A day",
      },
      {
        id: "the-week",
        parentId: null,
        prevSiblingId: "the-day",
        text: WEEK_RANGE,
      },
    ],
    {
      kv: dailyIndexKv([
        { key: DAY, nodeId: "the-day" },
        { key: WEEK, nodeId: "the-week" },
      ]),
    },
  );

  // Zoomed on the day note -> the strip is present, with the right orientation
  // chrome and the zoomed day selected.
  await clientNavigate(page, "/the-day");
  await expect(strip(page)).toBeVisible();
  await expect(page.getByTestId("week-calendar-month")).toHaveText(MONTH_YEAR);
  await expect(page.getByTestId("week-calendar-week-range")).toHaveText(
    WEEK_RANGE,
  );
  await expect(pill(page, DAY)).toHaveAttribute("data-selected", "");
  await expect(pill(page, DAY)).toHaveAttribute("aria-pressed", "true");

  // Home (top level): the strip collapses away.
  await clientNavigate(page, "/");
  await expect(strip(page)).toHaveCount(0);

  // A plain (non-daily) node: no strip.
  await clientNavigate(page, "/alpha");
  await expect(strip(page)).toHaveCount(0);

  // A WEEK scaffold node: no strip ("which day is selected?" has no answer).
  await clientNavigate(page, "/the-week");
  await expect(strip(page)).toHaveCount(0);
});

test("Sunday preference starts the strip and month picker on Sunday", async ({
  page,
}) => {
  const sunday = "2030-06-16";
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "sunday-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "Sunday, June 16, 2030",
      },
    ],
    {
      kv: {
        ...dailyIndexKv([{ key: sunday, nodeId: "sunday-day" }]),
        "account-prefs": [
          {
            key: "daily:week-start",
            value: { key: "daily:week-start", weekStart: "sunday" },
          },
        ],
      },
    },
  );

  await clientNavigate(page, "/sunday-day");
  await expect(strip(page)).toHaveAttribute("data-week-key", "week:2030-06-16");
  await expect(strip(page).locator("[data-day-key]").first()).toHaveAttribute(
    "data-day-key",
    sunday,
  );
  await page.getByTestId("week-calendar-month").click();
  await expect(
    page
      .getByTestId("week-calendar-month-picker")
      .locator(".grid-cols-7")
      .first()
      .locator("div")
      .first(),
  ).toHaveText("S");
});

test("clicking another day navigates to that day's node", async ({ page }) => {
  // Seed a NEIGHBOUR day too, so the click lands on an existing node and we can
  // assert the navigation deterministically.
  const OTHER = "2030-06-11"; // same Calendar week as DAY
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "the-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "A day",
      },
      {
        id: "other-day",
        parentId: null,
        prevSiblingId: "the-day",
        text: "Another day",
      },
    ],
    {
      kv: dailyIndexKv([
        { key: DAY, nodeId: "the-day" },
        { key: OTHER, nodeId: "other-day" },
      ]),
    },
  );

  await clientNavigate(page, "/the-day");
  await expect(strip(page)).toBeVisible();

  // Click the neighbour day pill -> navigate to its node.
  await pill(page, OTHER).click();
  await expect(page).toHaveURL(/\/other-day$/);
  // The strip now selects the newly-navigated day.
  await expect(pill(page, OTHER)).toHaveAttribute("data-selected", "");
  await expect(pill(page, DAY)).not.toHaveAttribute("data-selected");
});

test("the latest day click wins while an earlier creation is pending", async ({
  page,
}) => {
  const EARLIER = "2030-06-10";
  const LATEST = "2030-06-16";
  let earlierId = "";
  let latestId = "";
  let releaseEarlierClaim = () => {};
  let releaseLatestClaim = () => {};
  let markEarlierClaimSeen = () => {};
  let markLatestClaimSeen = () => {};
  const earlierClaimSeen = new Promise<void>((resolve) => {
    markEarlierClaimSeen = resolve;
  });
  const latestClaimSeen = new Promise<void>((resolve) => {
    markLatestClaimSeen = resolve;
  });
  const earlierClaimReleased = new Promise<void>((resolve) => {
    releaseEarlierClaim = resolve;
  });
  const latestClaimReleased = new Promise<void>((resolve) => {
    releaseLatestClaim = resolve;
  });
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "the-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "A day",
      },
    ],
    { kv: dailyIndexKv([{ key: DAY, nodeId: "the-day" }]) },
  );
  await page.route(
    (url) => url.pathname === "/api/kv",
    async (route) => {
      const request = route.request();
      // SAFETY: the fixture decodes every claim POST with KvClaimBody; optional
      // fields keep unrelated /api/kv requests outside the held branches.
      const body = request.postDataJSON() as {
        key?: string;
        value?: { nodeId?: string };
      } | null;
      const isClaim =
        request.method() === "POST" &&
        new URL(request.url()).searchParams.get("op") === "claim";
      if (isClaim && body?.key === EARLIER) {
        earlierId = body.value?.nodeId ?? "";
        markEarlierClaimSeen();
        await earlierClaimReleased;
      } else if (isClaim && body?.key === LATEST) {
        latestId = body.value?.nodeId ?? "";
        markLatestClaimSeen();
        await latestClaimReleased;
      }
      await route.fallback();
    },
  );

  await clientNavigate(page, "/the-day");
  await expect(strip(page)).toBeVisible();
  await pill(page, EARLIER).click();
  await earlierClaimSeen;
  await pill(page, LATEST).click();
  await latestClaimSeen;
  expect(earlierId).not.toBe("");
  expect(latestId).not.toBe("");

  // Settle the earlier request while the latest remains blocked. The earlier
  // node write proves get-or-create progressed past its held claim; the route
  // must remain on the source because only the latest click may navigate.
  const earlierWriteResponse = page.waitForResponse((response) => {
    const request = response.request();
    if (
      new URL(request.url()).pathname !== "/api/nodes" ||
      request.method() !== "POST"
    ) {
      return false;
    }
    // SAFETY: the fixture decodes every structural POST with NodesPostBody
    // before replying, so an operations array has this tested id shape.
    const body = request.postDataJSON() as {
      ops?: Array<{ value?: { id?: string } }>;
    } | null;
    return Boolean(
      body?.ops?.some((operation) => operation.value?.id === earlierId),
    );
  });
  releaseEarlierClaim();
  const response = await earlierWriteResponse;
  await response.finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page).toHaveURL(/\/the-day$/);

  releaseLatestClaim();
  await expect(page).toHaveURL(new RegExp(`/${latestId}$`));
});

test("clicking an un-minted day creates it WITHOUT seeding a child (seed-free)", async ({
  page,
}) => {
  const NEW = "2030-06-14"; // same Calendar week, no node/mapping yet
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "the-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "A day",
      },
    ],
    { kv: dailyIndexKv([{ key: DAY, nodeId: "the-day" }]) },
  );

  await clientNavigate(page, "/the-day");
  await expect(strip(page)).toBeVisible();

  // The target day has no mapping yet: clicking it get-or-creates + zooms.
  await pill(page, NEW).click();
  // Landed on a freshly-minted day node (a generated id, not "the-day").
  await expect(page).toHaveURL(/\/[^/]+$/);
  await expect(page).not.toHaveURL(/\/the-day$/);
  const newId = page.url().split("/").pop()!;
  expect(newId).not.toBe("the-day");

  // Its badge confirms it's the clicked day...
  await expect(
    page.locator("h2.zoomed-title [data-daily-date]"),
  ).toHaveAttribute("data-daily-date", NEW);

  // ...and it is SEED-FREE: back home, the new day node has zero children (no
  // stray entry line, unlike the write-intent Today button -- ADR 0041/0054).
  await clientNavigate(page, "/");
  await expect(page.locator(`li[data-parent-id="${newId}"]`)).toHaveCount(0);
});

test("dragging a node onto a day pill moves its subtree, stays put, and undoes in one step", async ({
  page,
}) => {
  const OTHER = "2030-06-11";
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "the-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "A day",
      },
      {
        id: "other-day",
        parentId: null,
        prevSiblingId: "the-day",
        text: "Another day",
      },
      {
        id: "move-me",
        parentId: "the-day",
        prevSiblingId: null,
        text: "Prepare launch notes",
      },
      {
        id: "move-child",
        parentId: "move-me",
        prevSiblingId: null,
        text: "Keep this child",
      },
    ],
    {
      kv: dailyIndexKv([
        { key: DAY, nodeId: "the-day" },
        { key: OTHER, nodeId: "other-day" },
      ]),
    },
  );
  await clientNavigate(page, "/the-day");

  // The selected day is a valid target too. Releasing here is the settled
  // silent no-op because this is already the final child.
  await dragNodeToDay(page, "move-me", DAY);
  await expect(pill(page, DAY)).toHaveAttribute(
    "data-external-drop-active",
    "",
  );
  await page.mouse.up();
  await expect(page.locator('output[aria-live="polite"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Go", exact: true }),
  ).toHaveCount(0);

  await dragNodeToDay(page, "move-me", OTHER);
  await expect(pill(page, OTHER)).toHaveAttribute(
    "data-external-drop-active",
    "",
  );
  await expect(page.locator(".drag-indicator")).not.toBeVisible();
  await page.mouse.up();

  await expect(page).toHaveURL(/\/the-day$/);
  await expect(
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText(/Tuesday, June 11, 2030/),
  ).toBeVisible();
  await expect(page.locator('li[data-node-id="move-me"]')).toHaveCount(0);

  // One undo restores the entire subtree to the source day.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page.locator('li[data-node-id="move-me"][data-parent-id="the-day"]'),
  ).toBeVisible();
  await expect(
    page.locator('li[data-node-id="move-child"][data-parent-id="move-me"]'),
  ).toBeVisible();
});

test("a selected run can be dragged by a descendant into a missing day in order", async ({
  page,
}) => {
  const NEW = "2030-06-14";
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "the-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "A day",
      },
      {
        id: "first",
        parentId: "the-day",
        prevSiblingId: null,
        text: "Prepare launch notes",
      },
      {
        id: "first-child",
        parentId: "first",
        prevSiblingId: null,
        text: "Draft announcement",
      },
      {
        id: "second",
        parentId: "the-day",
        prevSiblingId: "first",
        text: "Review launch notes",
      },
    ],
    {
      postDelayMs: 200,
      kv: dailyIndexKv([{ key: DAY, nodeId: "the-day" }]),
    },
  );
  await clientNavigate(page, "/the-day");

  const firstText = page.locator(
    'li[data-node-id="first"] > .outline-row .node-text',
  );
  await firstText.click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator('li[data-node-id="first"]')).toHaveAttribute(
    "data-selected",
    "top",
  );
  await expect(page.locator('li[data-node-id="second"]')).toHaveAttribute(
    "data-selected",
    "bottom",
  );

  // The grabbed child lies inside the selected slab, so the drag carries the
  // two selected roots (not the child alone) and advertises the extra node.
  await dragNodeToDay(page, "first-child", NEW);
  await expect(page.locator(".drag-pill")).toContainText("+1");
  await expect(pill(page, NEW)).toHaveAttribute(
    "data-external-drop-active",
    "",
  );
  await page.mouse.up();

  await expect(
    page.getByRole("button", { name: "Go", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/the-day$/);
  await page.getByRole("button", { name: "Go" }).click();

  const newId = page.url().split("/").pop()!;
  await expect(
    page.locator(`li[data-node-id="first"][data-parent-id="${newId}"]`),
  ).toBeVisible();
  await expect(
    page.locator(`li[data-node-id="second"][data-parent-id="${newId}"]`),
  ).toBeVisible();
  await expect(
    page.locator('li[data-node-id="first-child"][data-parent-id="first"]'),
  ).toBeVisible();
  await expect(page.locator('li[data-node-id="first"]')).not.toHaveAttribute(
    "data-selected",
  );
  await expect(page.locator('li[data-node-id="second"]')).not.toHaveAttribute(
    "data-selected",
  );
});

test("chevron paging changes the week, shows a snap-back, and resets navigation-free", async ({
  page,
}) => {
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "the-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "A day",
      },
    ],
    { kv: dailyIndexKv([{ key: DAY, nodeId: "the-day" }]) },
  );

  await clientNavigate(page, "/the-day");
  await expect(strip(page)).toBeVisible();
  await expect(page.getByTestId("week-calendar-week-range")).toHaveText(
    WEEK_RANGE,
  );
  // No snap-back while centred on the zoomed day's week.
  await expect(page.getByTestId("week-calendar-snapback")).toHaveCount(0);

  // Page forward one week: the date range advances and the snap-back
  // affordance appears -- and the URL does NOT change (paging is view-only).
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.getByTestId("week-calendar-week-range")).toHaveText(
    NEXT_WEEK_RANGE,
  );
  await expect(page.getByTestId("week-calendar-snapback")).toBeVisible();
  await expect(page).toHaveURL(/\/the-day$/);

  // Snap back: the strip re-centres, the affordance disappears, still no nav.
  await page.getByTestId("week-calendar-snapback").click();
  await expect(page.getByTestId("week-calendar-week-range")).toHaveText(
    WEEK_RANGE,
  );
  await expect(page.getByTestId("week-calendar-snapback")).toHaveCount(0);
  await expect(page).toHaveURL(/\/the-day$/);
});

test("month label opens a picker that jumps to a far day (ADR 0055)", async ({
  page,
}) => {
  // FAR is in the next month (July 2030); not in DAY's Calendar week.
  const FAR = "2030-07-15";
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "the-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "A day",
      },
      {
        id: "far-day",
        parentId: null,
        prevSiblingId: "the-day",
        text: "Far day",
      },
    ],
    {
      kv: dailyIndexKv([
        { key: DAY, nodeId: "the-day" },
        { key: FAR, nodeId: "far-day" },
      ]),
    },
  );

  await clientNavigate(page, "/the-day");
  await expect(strip(page)).toBeVisible();

  await page.getByTestId("week-calendar-month").click();
  const picker = page.getByTestId("week-calendar-month-picker");
  await expect(picker).toBeVisible();

  // Page to July 2030, then pick the 15th.
  await page.getByTestId("month-picker-next").click();
  await expect(picker).toContainText("July");
  await picker.locator(`[data-day-key="${FAR}"]`).click();

  await expect(page).toHaveURL(/\/far-day$/);
  await expect(strip(page)).toBeVisible();
  await expect(pill(page, FAR)).toHaveAttribute("data-selected", "");
  await expect(page.getByTestId("week-calendar-month")).toHaveText("July 2030");
});
