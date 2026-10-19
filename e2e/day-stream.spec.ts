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
