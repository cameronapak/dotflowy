import { expect, test, type Page } from "@playwright/test";

import {
  dayKeyToWeekKey,
  monthKeyToYearKey,
  monthLabel,
  shiftWeekKey,
  weekKeyToMonthKey,
  weekLabel,
} from "../src/data/date-links";
import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// A fixed ISO week far from "now", so month/year/week-number assertions are
// stable whatever day the suite runs on. 2030-06-12 is a Wednesday in 2030-W24
// (Mon 2030-06-10 .. Sun 2030-06-16), month June 2030.
const DAY = "2030-06-12";
const WEEK = dayKeyToWeekKey(DAY)!; // 2030-W24
const MONTH_YEAR = `${monthLabel(weekKeyToMonthKey(WEEK)!)} ${monthKeyToYearKey(
  weekKeyToMonthKey(WEEK)!,
)}`; // "June 2030"
const WEEKNUM = `W${Number(WEEK.slice(6))}`; // W24
const NEXT_WEEKNUM = `W${Number(shiftWeekKey(WEEK, 1)!.slice(6))}`; // W25

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
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="alpha"] > .outline-row .node-text'),
  ).toBeVisible();
}

const strip = (page: Page) => page.getByTestId("week-calendar");
const pill = (page: Page, key: string) =>
  page.locator(`[data-testid="week-calendar"] [data-day-key="${key}"]`);

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
          const el = document.querySelector('[data-testid="week-calendar"]');
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

test.describe("week calendar strip (ADR 0054)", () => {
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
    await expect(page.getByTestId("week-calendar-month")).toHaveText(
      MONTH_YEAR,
    );
    await expect(page.getByTestId("week-calendar-weeknum")).toHaveText(WEEKNUM);
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

  test("clicking another day navigates to that day's node", async ({
    page,
  }) => {
    // Seed a NEIGHBOUR day too, so the click lands on an existing node and we can
    // assert the navigation deterministically.
    const OTHER = "2030-06-11"; // same ISO week as DAY
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

  test("clicking an un-minted day creates it WITHOUT seeding a child (seed-free)", async ({
    page,
  }) => {
    const NEW = "2030-06-14"; // same ISO week, no node/mapping yet
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
    await expect(page.getByTestId("week-calendar-weeknum")).toHaveText(WEEKNUM);
    // No snap-back while centred on the zoomed day's week.
    await expect(page.getByTestId("week-calendar-snapback")).toHaveCount(0);

    // Page forward one week: the week-number badge advances and the snap-back
    // affordance appears -- and the URL does NOT change (paging is view-only).
    await page.getByRole("button", { name: "Next week" }).click();
    await expect(page.getByTestId("week-calendar-weeknum")).toHaveText(
      NEXT_WEEKNUM,
    );
    await expect(page.getByTestId("week-calendar-snapback")).toBeVisible();
    await expect(page).toHaveURL(/\/the-day$/);

    // Snap back: the strip re-centres, the affordance disappears, still no nav.
    await page.getByTestId("week-calendar-snapback").click();
    await expect(page.getByTestId("week-calendar-weeknum")).toHaveText(WEEKNUM);
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
});
