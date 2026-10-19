import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  STANDARD_TREE,
  text,
} from "./fixtures";

// ADR 0070: a zoomed day note continues into the days around it. Fixed days far
// from "now", so the stream around them is all Empty days but these two.
const DAY = "2030-06-12";
const PREV = "2030-06-11";
const NEXT = "2030-06-13";

const TREE = [
  ...STANDARD_TREE,
  { id: "the-day", parentId: null, prevSiblingId: "charlie", text: "" },
  { id: "standup", parentId: "the-day", prevSiblingId: null, text: "Standup" },
  { id: "prev-day", parentId: null, prevSiblingId: "the-day", text: "" },
  { id: "dentist", parentId: "prev-day", prevSiblingId: null, text: "Dentist" },
];
const KV = {
  "daily-index": [
    { key: DAY, value: { key: DAY, nodeId: "the-day" } },
    { key: PREV, value: { key: PREV, nodeId: "prev-day" } },
  ],
};

async function clientNavigate(page: Page, path: string) {
  // Client navigation keeps the seeded in-memory store (a reload re-syncs).
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function openDay(page: Page) {
  await seedOutline(page, TREE, { kv: KV });
  await openSeededOutline(page, { anchorId: "alpha" });
  await clientNavigate(page, "/the-day");
  await expect(section(page, DAY, "title")).toBeVisible();
}

/** Hold the daily-index claim for `key` until the returned release runs. */
async function holdClaim(page: Page, key: string) {
  let release = () => {};
  let seen = () => {};
  const claimSeen = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/kv",
    async (route) => {
      const request = route.request();
      // SAFETY: claim POSTs carry a JSON body with a key; others pass through.
      const body = request.postDataJSON() as { key?: string } | null;
      if (
        request.method() === "POST" &&
        new URL(request.url()).searchParams.get("op") === "claim" &&
        body?.key === key
      ) {
        seen();
        await released;
      }
      await route.fallback();
    },
  );
  return { claimSeen, release };
}

const section = (page: Page, key: string, kind: string) =>
  page.locator(`[data-stream-item="${kind}"][data-section="${key}"]`);
const pill = (page: Page, key: string) =>
  page
    .getByRole("navigation", { name: "Week calendar" })
    .locator(`[data-day-key="${key}"]`);

test("a pill scrolls the stream, and the URL and strip follow the day in view", async ({
  page,
}) => {
  await openDay(page);

  await pill(page, PREV).click();
  await expect(page.locator("li[data-node-id=dentist]")).toBeInViewport();
  // The route keeps its anchor; only the search param names the day in view.
  await expect(page).toHaveURL(new RegExp(`/the-day\\?day=${PREV}$`));
  await expect(pill(page, PREV)).toHaveAttribute("data-selected", "");

  await pill(page, DAY).click();
  await expect(page).toHaveURL(/\/the-day$/);
});

test("writing in an Empty day creates its note and keeps every keystroke", async ({
  page,
}) => {
  await openDay(page);
  await expect(section(page, NEXT, "placeholder")).toBeAttached();

  await pill(page, NEXT).click();
  await page.locator(`[data-stream-entry="${NEXT}"]`).click();
  await page.keyboard.type("Gym at 7");

  // The placeholder became a real day, and the caret moved into its row.
  await expect(section(page, NEXT, "title")).toBeVisible();
  await expect(section(page, NEXT, "placeholder")).toHaveCount(0);
  const active = page.locator(":focus");
  await expect(active).toHaveText("Gym at 7");
  await page.keyboard.type("!");
  await expect(active).toHaveText("Gym at 7!");
});

test("a click elsewhere while an Empty day is being created keeps typing there", async ({
  page,
}) => {
  await openDay(page);
  const claim = await holdClaim(page, NEXT);
  await pill(page, NEXT).click();
  await page.locator(`[data-stream-entry="${NEXT}"]`).click();
  await page.keyboard.type("X");
  await claim.claimSeen;

  // The user moves on before the day exists.
  await pill(page, DAY).click();
  await placeCaret(text(page, "standup"), "end");
  await page.keyboard.type("Z");
  claim.release();

  await expect(section(page, NEXT, "title")).toBeAttached();
  await expect(text(page, "standup")).toHaveText("StandupZ");
  await expect(text(page, "standup")).toBeFocused();
  await expect(
    page.locator(".node-text").filter({ hasText: /^X$/ }),
  ).toHaveCount(1);
});

test("a filter sends commands back to the zoom root, not the last day touched", async ({
  page,
}) => {
  await openDay(page);
  // Working in the previous day points commands at it.
  await pill(page, PREV).click();
  await placeCaret(text(page, "dentist"), "end");

  // A filter shows only the anchor day, with no stream.
  await clientNavigate(page, "/the-day?q=Standup");
  await expect(page.locator("[data-stream-item]")).toHaveCount(0);
  await placeCaret(text(page, "standup"), "end");
  // Outdenting a direct child of the zoom root does nothing. Aimed at the
  // previous day instead, it moved Standup out of this day, out of view.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("!");
  await expect(text(page, "standup")).toHaveText("Standup!");
});

test("a cold link to ?day= opens on that day and keeps it in the URL", async ({
  page,
}) => {
  const LATER = "2030-07-12";
  await seedOutline(page, TREE, { kv: KV });
  await openSeededOutline(page, { path: `/the-day?day=${LATER}` });
  await expect(section(page, LATER, "placeholder")).toBeInViewport();
  await expect(pill(page, LATER)).toHaveAttribute("data-selected", "");
  // Past the URL debounce, the link's destination is still there.
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(new RegExp(`/the-day\\?day=${LATER}$`));
});

test("a calendar pick past the stream's reach navigates there", async ({
  page,
}) => {
  const FAR = "2030-09-12"; // beyond the stream's 60-day reach from June 12
  await openDay(page);
  await page.getByTestId("week-calendar-month").click();
  const picker = page.getByTestId("week-calendar-month-picker");
  for (const month of ["July", "August", "September"]) {
    await page.getByTestId("month-picker-next").click();
    await expect(picker).toContainText(month);
  }
  await picker.locator(`[data-day-key="${FAR}"]`).click();

  await expect(page).not.toHaveURL(/\/the-day/);
  await expect(section(page, FAR, "title")).toBeInViewport();
  await expect(pill(page, FAR)).toHaveAttribute("data-selected", "");
});

test("typing stays local and scrolling reuses day-stream layout and content", async ({
  page,
}) => {
  // Observe the running React tree through its DevTools hook, not production
  // counters. PerformedWork is React 19's render flag. Skip shared child lists:
  // a bailout can leave old flags on fibers that did NOT render this commit.
  await page.addInitScript(() => {
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = {
      type: { name?: string } | null;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
      memoizedState: Hook | null;
      memoizedProps: { rowKey?: string };
    };
    const names = new Set([
      "OutlineEditor",
      "NormalRow",
      "StreamSectionTitle",
      "StreamPlaceholderTitle",
      "StreamEntryLine",
    ]);
    let geometry: unknown;
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      value: {
        supportsFiber: true,
        renderers: new Map<number, unknown>(),
        inject() {
          return 1;
        },
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          const visit = (fiber: Fiber) => {
            const name = fiber.type?.name;
            if (name && names.has(name) && fiber.flags & 1) {
              performance.mark(
                `render:${name}:${fiber.memoizedProps.rowKey ?? ""}`,
              );
              if (name === "OutlineEditor") {
                for (let hook = fiber.memoizedState; hook; hook = hook.next) {
                  // The virtualizer is held in React state. Its public layout
                  // snapshot must stay identical on a scroll-only commit.
                  // SAFETY: Hook state is heterogeneous; this optional view is
                  // used only after checking the method and array below.
                  const value = hook.memoizedState as {
                    getVirtualItems?: unknown;
                    measurementsCache?: unknown;
                  } | null;
                  if (
                    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- React hook state has no schema; identify the virtualizer by its public method.
                    typeof value?.getVirtualItems !== "function" ||
                    !Array.isArray(value.measurementsCache)
                  )
                    continue;
                  performance.mark("layout:observed");
                  if (geometry && geometry !== value.measurementsCache)
                    performance.mark("layout:rebuild");
                  geometry = value.measurementsCache;
                }
              }
            }
            if (!fiber.alternate || fiber.child !== fiber.alternate.child)
              for (let child = fiber.child; child; child = child.sibling)
                visit(child);
          };
          visit(root.current);
        },
        onCommitFiberUnmount() {},
      },
    });
  });
  const entries = Array.from({ length: 200 }, (_, i) => ({
    id: `entry-${i}`,
    parentId: "the-day",
    prevSiblingId: i ? `entry-${i - 1}` : "standup",
    text: `Entry ${i}`,
  }));
  await seedOutline(page, [...TREE, ...entries], { kv: KV });
  await openSeededOutline(page, { path: "/the-day" });
  await placeCaret(text(page, "standup"), "end");

  const marks = () =>
    page.evaluate(() =>
      performance
        .getEntriesByType("mark")
        .map((entry) => entry.name)
        .filter((name) => /^(render:|layout:)/.test(name)),
    );
  const settle = async () => {
    let previous = -1;
    let equal = 0;
    await expect
      .poll(
        async () => {
          const count = (await marks()).length;
          equal = count === previous ? equal + 1 : 0;
          previous = count;
          return equal;
        },
        { intervals: [100] },
      )
      .toBeGreaterThanOrEqual(3);
  };
  await settle();
  await page.evaluate(() => performance.clearMarks());
  await page.keyboard.type("abcdefghij");
  await expect(text(page, "standup")).toHaveText("Standupabcdefghij");
  await settle();
  const typing = await marks();
  expect(typing).toContain("render:NormalRow:standup");
  expect(
    typing.filter(
      (name) =>
        name.startsWith("render:NormalRow:") &&
        name !== "render:NormalRow:standup",
    ),
  ).toEqual([]);
  expect(typing).not.toContain("render:OutlineEditor:");

  // Stay in an already measured window: no newly mounted rows or edge loads
  // can legitimately invalidate layout. The shell must render, its content not.
  await page.evaluate(() => {
    performance.clearMarks();
    window.scrollBy(0, 8);
  });
  await settle();
  const scrolling = await marks();
  expect(scrolling).toContain("render:OutlineEditor:");
  expect(scrolling).toContain("layout:observed");
  expect(scrolling).not.toContain("layout:rebuild");
  expect(
    scrolling.filter((name) =>
      /^render:Stream(SectionTitle|PlaceholderTitle|EntryLine):/.test(name),
    ),
  ).toEqual([]);

  // A real geometry change must still update empty-day page heights, including
  // a small resize that does not change the virtualizer's rendered range.
  await pill(page, NEXT).click();
  const following = section(page, "2030-06-14", "placeholder");
  const gap = () =>
    page.evaluate(() => {
      const first = document.querySelector<HTMLElement>(
        '[data-stream-item="placeholder"][data-section="2030-06-13"]',
      )!;
      const second = document.querySelector<HTMLElement>(
        '[data-stream-item="placeholder"][data-section="2030-06-14"]',
      )!;
      return (
        second.getBoundingClientRect().top - first.getBoundingClientRect().top
      );
    });
  await expect(section(page, NEXT, "placeholder")).toBeInViewport();
  await expect(following).toBeAttached();
  await settle();
  const before = await gap();
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ ...viewport, height: viewport.height + 24 });
  await expect.poll(gap).toBe(before + 24);
  await page.setViewportSize(viewport);
  await expect.poll(gap).toBe(before);
});
