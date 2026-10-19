import { expect, test, type Page } from "@playwright/test";

import { openSeededOutline, seedOutline, STANDARD_TREE } from "./fixtures";

// ADR 0070: a zoomed day note continues into the days around it. Fixed days far
// from "now", so the stream around them is all Empty days but these two.
const DAY = "2030-06-12";
const PREV = "2030-06-11";
const NEXT = "2030-06-13";

async function openDay(page: Page) {
  await seedOutline(
    page,
    [
      ...STANDARD_TREE,
      { id: "the-day", parentId: null, prevSiblingId: "charlie", text: "" },
      { id: "prev-day", parentId: null, prevSiblingId: "the-day", text: "" },
      {
        id: "dentist",
        parentId: "prev-day",
        prevSiblingId: null,
        text: "Dentist",
      },
    ],
    {
      kv: {
        "daily-index": [
          { key: DAY, value: { key: DAY, nodeId: "the-day" } },
          { key: PREV, value: { key: PREV, nodeId: "prev-day" } },
        ],
      },
    },
  );
  await openSeededOutline(page, { anchorId: "alpha" });
  // Client navigation keeps the seeded in-memory store (a reload re-syncs).
  await page.evaluate(() => {
    window.history.pushState({}, "", "/the-day");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(section(page, DAY, "title")).toBeVisible();
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
