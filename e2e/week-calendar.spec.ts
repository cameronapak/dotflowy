import { expect, test, type Page } from "@playwright/test";

import {
  dayKeyToWeekKey,
  formatDateFull,
  monthKeyToYearKey,
  monthLabel,
  shiftWeekKey,
  weekKeyToMonthKey,
  weekLabel,
} from "../src/data/date-links";
import {
  openSeededOutline,
  seedOutline,
  STANDARD_TREE,
  type SeedNode,
} from "./fixtures";

// A fixed Calendar week far from "now", so month/year/range assertions are
// stable whatever day the suite runs on.
const DAY = "2030-06-12";
const WEEK = dayKeyToWeekKey(DAY)!;
const MONTH_YEAR = `${monthLabel(weekKeyToMonthKey(WEEK)!)} ${monthKeyToYearKey(
  weekKeyToMonthKey(WEEK)!,
)}`; // "June 2030"
const WEEK_RANGE = weekLabel(WEEK);
const NEXT_WEEK_RANGE = weekLabel(shiftWeekKey(WEEK, 1)!);

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

async function load(
  page: Page,
  tree: SeedNode[],
  kv: Parameters<typeof seedOutline>[2],
) {
  await seedOutline(page, tree, kv);
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

/** Sample the subheader band (the motion.div wrapping the strip) height on every
 *  animation frame for `ms`, skipping frames where the strip is absent. Returns
 *  the trajectory so the caller can assert it snapped (flat) vs eased (a ramp).
 *  Starts immediately, so install it right before the action being measured. */
function sampleBandHeights(page: Page, ms = 400): Promise<number[]> {
  return page.evaluate(
    (dur) =>
      new Promise<number[]>((resolve) => {
        const heights: number[] = [];
        const start = performance.now();
        const tick = () => {
          const el = document.querySelector("[data-week-calendar]");
          const band = el?.closest<HTMLElement>(".overflow-hidden") ?? null;
          if (band)
            heights.push(Math.round(band.getBoundingClientRect().height));
          if (performance.now() - start < dur) requestAnimationFrame(tick);
          else resolve(heights);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

type SelectionMidpoint = {
  source: { left: number; top: number; width: number; height: number };
  destinationLeft: number;
  midpoint: { left: number; top: number; width: number; height: number };
  sourceBandHeight: number;
  midpointBandHeight: number;
  midpointBandOpacity: number;
};

/** Catch the destination CSS animation, pause it at 50%, and measure the pill
 *  relative to the stationary calendar. This proves an intermediate frame
 *  exists; endpoint samples alone would let an instant jump pass. */
function pauseSelectionAtMidpoint(
  page: Page,
  destinationDayKey: string,
): Promise<SelectionMidpoint> {
  return page.evaluate(
    (destination) =>
      new Promise<SelectionMidpoint>((resolve, reject) => {
        const sourceCalendar = document.querySelector<HTMLElement>(
          "[data-week-calendar]",
        );
        const sourceSelection = document.querySelector<HTMLElement>(
          "[data-week-calendar-selection]",
        );
        const destinationButton = sourceCalendar?.querySelector<HTMLElement>(
          `[data-day-key="${destination}"]`,
        );
        const sourceBand =
          sourceCalendar?.closest<HTMLElement>(".overflow-hidden");
        if (
          !sourceCalendar ||
          !sourceSelection ||
          !destinationButton ||
          !sourceBand
        ) {
          reject(new Error("selection animation source is missing"));
          return;
        }
        const calendarRect = sourceCalendar.getBoundingClientRect();
        const sourceRect = sourceSelection.getBoundingClientRect();
        const destinationRect = destinationButton.getBoundingClientRect();
        const source = {
          left: sourceRect.left - calendarRect.left,
          top: sourceRect.top - calendarRect.top,
          width: sourceRect.width,
          height: sourceRect.height,
        };
        const destinationLeft = destinationRect.left - calendarRect.left;
        const sourceBandHeight = sourceBand.getBoundingClientRect().height;
        const start = performance.now();
        const tick = () => {
          const calendar = document.querySelector<HTMLElement>(
            "[data-week-calendar]",
          );
          const selection = document.querySelector<HTMLElement>(
            "[data-week-calendar-selection]",
          );
          const selectedDestination = calendar
            ?.querySelector(`[data-day-key="${destination}"]`)
            ?.hasAttribute("data-selected");
          const animation = selection
            ?.getAnimations()
            .find(
              (candidate) =>
                candidate instanceof CSSAnimation &&
                candidate.animationName === "week-calendar-selection-slide",
            );
          if (calendar && selection && selectedDestination && animation) {
            animation.pause();
            animation.currentTime = 100;
            requestAnimationFrame(() => {
              const currentCalendarRect = calendar.getBoundingClientRect();
              const selectionRect = selection.getBoundingClientRect();
              const band = calendar.closest<HTMLElement>(".overflow-hidden");
              if (!band) {
                reject(new Error("selection animation band is missing"));
                return;
              }
              resolve({
                source,
                destinationLeft,
                midpoint: {
                  left: selectionRect.left - currentCalendarRect.left,
                  top: selectionRect.top - currentCalendarRect.top,
                  width: selectionRect.width,
                  height: selectionRect.height,
                },
                sourceBandHeight,
                midpointBandHeight: band.getBoundingClientRect().height,
                midpointBandOpacity: Number(getComputedStyle(band).opacity),
              });
            });
            return;
          }
          if (performance.now() - start >= 10_000) {
            reject(
              new Error("destination selection animation was not observed"),
            );
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    destinationDayKey,
  );
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
        text: weekLabel(WEEK),
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
  const sundayWeek = dayKeyToWeekKey(sunday, "sunday")!;
  await load(
    page,
    [
      ...STANDARD_TREE,
      {
        id: "sunday-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: formatDateFull(sunday),
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
  await expect(strip(page)).toHaveAttribute("data-week-key", sundayWeek);
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

  // The subheader band must SNAP across the day switch, not re-open. The
  // editor (and its subheader) remounts per day; the band measures and paints
  // its full height on mount with NO animation (ADR 0054 decision 4, the
  // double-rAF mount-snap guard). Install the frame sampler, THEN click, so it
  // captures the whole remount. Countable DOM read: the height trajectory is
  // flat -- max minus min is ~0. With the bug (the band easing 0->full over
  // SUBHEADER_EXPAND_MS) this ramp is ~90px, so the delta is the signal, not a
  // wall-clock threshold. A plain settled `height > 0` check missed it (the
  // band was non-zero the whole time it was mid-reopen).
  const heights = sampleBandHeights(page);

  // Click the neighbour day pill -> navigate to its node.
  await pill(page, OTHER).click();
  await expect(page).toHaveURL(/\/other-day$/);
  // The strip now selects the newly-navigated day.
  await expect(pill(page, OTHER)).toHaveAttribute("data-selected", "");
  await expect(pill(page, DAY)).not.toHaveAttribute("data-selected");

  const samples = await heights;
  expect(samples.length).toBeGreaterThan(0);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  expect(max).toBeGreaterThan(0); // the band stayed open (never collapsed)
  expect(max - min).toBeLessThan(12); // and it snapped -- no 0->full ramp
});

test("the selection pill moves only on the x-axis from a scrolled day", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  const OTHER = "2030-06-16"; // Sunday in the same ISO week as DAY.
  const entries: SeedNode[] = Array.from({ length: 48 }, (_, i) => ({
    id: `entry-${i}`,
    parentId: "the-day",
    prevSiblingId: i === 0 ? null : `entry-${i - 1}`,
    text: `Entry ${i}`,
  }));
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
      ...entries,
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
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200);

  const midpointPromise = pauseSelectionAtMidpoint(page, OTHER);
  await pill(page, OTHER).click();
  await expect(page).toHaveURL(/\/other-day$/);

  const frame = await midpointPromise;
  const leftEdge = Math.min(frame.source.left, frame.destinationLeft);
  const rightEdge = Math.max(frame.source.left, frame.destinationLeft);
  expect(frame.midpoint.left).toBeGreaterThan(leftEdge + 5);
  expect(frame.midpoint.left).toBeLessThan(rightEdge - 5);
  expect(Math.abs(frame.midpoint.top - frame.source.top)).toBeLessThan(2);
  expect(Math.abs(frame.midpoint.width - frame.source.width)).toBeLessThan(2);
  expect(Math.abs(frame.midpoint.height - frame.source.height)).toBeLessThan(2);
  expect(
    Math.abs(frame.midpointBandHeight - frame.sourceBandHeight),
  ).toBeLessThan(12);
  expect(frame.midpointBandOpacity).toBe(1);

  // A tree update changes the destination's content dot and rerenders the
  // calendar. The latched handoff must remain paused at its midpoint.
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  const selection = page.locator("[data-week-calendar-selection]");
  await expect(selection).toHaveClass(/week-calendar-selection-slide/);
  expect(
    await selection.evaluate((element) =>
      element
        .getAnimations()
        .some(
          (animation) =>
            animation instanceof CSSAnimation &&
            animation.animationName === "week-calendar-selection-slide" &&
            animation.currentTime === 100,
        ),
    ),
  ).toBe(true);

  // Paging removes the selected span and cancels its animation. Returning to
  // the current week must not replay the stale day-switch handoff.
  await page.getByRole("button", { name: "Next week" }).click();
  await page.getByRole("button", { name: "Back to the current week" }).click();
  await expect(selection).not.toHaveClass(/week-calendar-selection-slide/);
  expect(
    await selection.evaluate((element) => element.getAnimations().length),
  ).toBe(0);
});

test("enabling reduced motion cancels an active pill without replay", async ({
  page,
}) => {
  const OTHER = "2030-06-16";
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
  const midpointPromise = pauseSelectionAtMidpoint(page, OTHER);
  await pill(page, OTHER).click();
  await expect(page).toHaveURL(/\/other-day$/);
  await midpointPromise;

  const selection = page.locator("[data-week-calendar-selection]");
  const heights = sampleBandHeights(page);
  // Motion snapshots this preference at mount. The CSS media query cancels
  // the already-running animation without remounting the destination.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(selection).not.toHaveClass(/week-calendar-selection-slide/);
  expect(
    await selection.evaluate((element) => element.getAnimations().length),
  ).toBe(0);
  // Returning to no preference must not replay the cancelled handoff.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(selection).not.toHaveClass(/week-calendar-selection-slide/);
  expect(
    await selection.evaluate((element) => element.getAnimations().length),
  ).toBe(0);
  const samples = await heights;
  expect(Math.max(...samples) - Math.min(...samples)).toBeLessThan(12);
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

test("a delayed creation measures the current day button after week paging", async ({
  page,
}) => {
  const NEW = "2030-06-10";
  let releaseClaim = () => {};
  let markClaimSeen = () => {};
  const claimSeen = new Promise<void>((resolve) => {
    markClaimSeen = resolve;
  });
  const claimReleased = new Promise<void>((resolve) => {
    releaseClaim = resolve;
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
      // SAFETY: the fixture decodes every claim POST with KvClaimBody; an
      // optional key keeps unrelated /api/kv requests outside this hold.
      const body = request.postDataJSON() as { key?: string } | null;
      if (
        request.method() === "POST" &&
        new URL(request.url()).searchParams.get("op") === "claim" &&
        body?.key === NEW
      ) {
        markClaimSeen();
        await claimReleased;
      }
      await route.fallback();
    },
  );

  await clientNavigate(page, "/the-day");
  await expect(strip(page)).toBeVisible();
  const midpointPromise = pauseSelectionAtMidpoint(page, NEW);
  await pill(page, NEW).click();
  await claimSeen;
  await page.getByRole("button", { name: "Next week" }).click();
  await page.getByRole("button", { name: "Back to the current week" }).click();
  releaseClaim();

  await expect(page).not.toHaveURL(/\/the-day$/);
  const frame = await midpointPromise;
  const leftEdge = Math.min(frame.source.left, frame.destinationLeft);
  const rightEdge = Math.max(frame.source.left, frame.destinationLeft);
  expect(frame.midpoint.left).toBeGreaterThan(leftEdge + 5);
  expect(frame.midpoint.left).toBeLessThan(rightEdge - 5);
  expect(Math.abs(frame.midpoint.top - frame.source.top)).toBeLessThan(2);
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

  // The selected day is a valid target too. Its ordinary primary fill must
  // disappear immediately so the muted target state remains readable, and
  // the quiet outer border keeps the button's own corner radius. Releasing
  // here is the settled silent no-op because this is already the final child.
  await dragNodeToDay(page, "move-me", DAY);
  await expect(pill(page, DAY)).toHaveAttribute(
    "data-external-drop-active",
    "",
  );
  await expect(pill(page, DAY).locator("span.bg-primary")).toHaveCSS(
    "display",
    "none",
  );
  const targetStyles = await pill(page, DAY).evaluate((element) => ({
    color: getComputedStyle(element.querySelector(".tabular-nums")!).color,
    titleColor: getComputedStyle(document.querySelector("h2")!).color,
    radius: getComputedStyle(element).borderRadius,
    outerRadius: getComputedStyle(element, "::after").borderRadius,
  }));
  expect(targetStyles.color).toBe(targetStyles.titleColor);
  expect(targetStyles.outerRadius).toBe(targetStyles.radius);
  await page.mouse.up();
  await expect(page.getByText(/^Moved /)).toHaveCount(0);

  await dragNodeToDay(page, "move-me", OTHER);
  await expect(pill(page, OTHER)).toHaveAttribute(
    "data-external-drop-active",
    "",
  );
  await expect(page.locator(".drag-indicator")).not.toBeVisible();
  await page.mouse.up();

  await expect(page).toHaveURL(/\/the-day$/);
  await expect(
    page.getByText(`Moved to ${formatDateFull(OTHER)}`),
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

  await expect(page.locator('output[aria-live="polite"]')).toBeVisible();
  await expect(
    page.getByText(`Moved 2 nodes to ${formatDateFull(NEW)}`),
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

test("a day with children shows a content dot; an empty day does not", async ({
  page,
}) => {
  const WITH = "2030-06-11"; // has a child
  await load(
    page,
    [
      ...STANDARD_TREE,
      // The zoomed day itself is empty (no children).
      {
        id: "the-day",
        parentId: null,
        prevSiblingId: "charlie",
        text: "A day",
      },
      // A neighbour day WITH a child -> its pill should carry a dot.
      {
        id: "with-day",
        parentId: null,
        prevSiblingId: "the-day",
        text: "Busy day",
      },
      {
        id: "with-day-child",
        parentId: "with-day",
        prevSiblingId: null,
        text: "wrote something",
      },
    ],
    {
      kv: dailyIndexKv([
        { key: DAY, nodeId: "the-day" },
        { key: WITH, nodeId: "with-day" },
      ]),
    },
  );

  await clientNavigate(page, "/the-day");
  await expect(strip(page)).toBeVisible();

  // The day with a child carries the content dot...
  await expect(pill(page, WITH).locator("[data-has-content]")).toHaveCount(1);
  // ...while the empty (zoomed) day does not.
  await expect(pill(page, DAY).locator("[data-has-content]")).toHaveCount(0);
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
