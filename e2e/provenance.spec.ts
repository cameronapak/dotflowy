import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  seedOutline,
  text,
  type SeedNode,
} from "./fixtures";

// The provenance plugin marks nodes an agent created via MCP (the write-once
// `origin` field) apart from what the user typed. The mark is a Seam F slot in
// both render paths (list bullet + zoomed title). This spec locks that a
// human-authored node stays unmarked, an agent-authored one shows the mark with
// its app attribution, and the mark rides the zoom into the title.

const TREE: SeedNode[] = [
  { id: "mine", parentId: null, prevSiblingId: null, text: "i typed this" },
  {
    id: "ai",
    parentId: null,
    prevSiblingId: "mine",
    text: "an agent added this",
    origin: "Claude",
  },
  {
    id: "amp",
    parentId: null,
    prevSiblingId: "ai",
    text: "an Amp-created node",
    origin: "Amp",
  },
  {
    id: "unknown",
    parentId: null,
    prevSiblingId: "amp",
    text: "a node from another AI app",
    origin: "Unknown app",
  },
];

// The mark is the source app's logo (ADR 0081) in a box carrying `data-origin`
// (the app name) and an aria-label attribution -- the same hook styles.css keys
// its alignment rule on.
const mark = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row [data-origin]`);

test("agent task continuation lines wrap underneath the checkbox and source mark", async ({
  page,
}) => {
  await page.setViewportSize({ width: 540, height: 800 });
  await seedOutline(page, [
    {
      id: "wrapped",
      parentId: null,
      prevSiblingId: null,
      text: "Ask Brian for a final review of the Platform Developer Hub CI/CD speedup; my pipeline reruns fail with a permissions error since his preview-auth fix",
      isTask: true,
      origin: "Unknown app",
    },
  ]);
  await openSeededOutline(page, { anchorId: "wrapped" });
  for (const size of ["small", "default", "large"]) {
    await page.evaluate(
      (size) => (document.documentElement.dataset.textSize = size),
      size,
    );
    await expect(async () => {
      const { left, lines } = await text(page, "wrapped").evaluate((el) => {
        const source = el.firstChild!;
        const starts = new Map<number, number>();
        for (let i = 0; i < source.textContent!.length; i++) {
          if (!source.textContent![i]!.trim()) continue;
          const range = document.createRange();
          range.setStart(source, i);
          range.setEnd(source, i + 1);
          const rect = range.getBoundingClientRect();
          if (!starts.has(rect.top)) starts.set(rect.top, rect.left);
        }
        return {
          left: el.getBoundingClientRect().left,
          lines: [...starts.values()],
        };
      });
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0]).toBeGreaterThan(left);
      for (const start of lines.slice(1)) expect(start).toBeCloseTo(left, 0);
    }).toPass({ timeout: 2000 });
  }
});

async function load(page: Page) {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "mine" });
}

test("AI app icons default on, switch to a shared sparkle, and keep attribution across reloads and failed saves", async ({
  page,
}) => {
  await load(page);

  // The user's node carries no mark.
  await expect(mark(page, "mine")).toHaveCount(0);

  // The agent's node does, tagged with the app name plus an aria-label
  // attribution (the visible copy lives in the hover tooltip).
  const agentMark = mark(page, "ai");
  await expect(agentMark).toBeVisible();
  await expect(agentMark).toHaveAttribute("data-origin", "Claude");
  await expect(agentMark).toHaveAttribute("aria-label", /Created by Claude/);

  // Zoom the agent node in by clicking its bullet dot.
  await page.locator(`li[data-node-id="ai"] .bullet`).first().click();

  // The zoomed title (registered under the rootId) shows the same mark.
  const titleMark = page.locator(`.zoomed-title [data-origin]`);
  await expect(titleMark).toBeVisible();
  await expect(titleMark).toHaveAttribute("data-origin", "Claude");
  const claudeLogo = await titleMark.locator("svg").innerHTML();

  await page.goto("/settings#appearance");
  const toggle = page.getByRole("switch", { name: "Show AI app icons" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "Back to outline" }).click();
  await expect(mark(page, "mine")).toHaveCount(0);
  const sparkle = await mark(page, "ai").locator("svg").innerHTML();
  expect(sparkle.length).toBeGreaterThan(0);
  expect(sparkle).not.toBe(claudeLogo);
  for (const id of ["amp", "unknown"]) {
    await expect(mark(page, id)).toBeVisible();
    expect(await mark(page, id).locator("svg").innerHTML()).toBe(sparkle);
  }
  await mark(page, "ai").hover();
  await expect(page.getByText(/^Created by Claude ·/)).toBeVisible();
  await page.locator('li[data-node-id="ai"] .bullet').first().click();
  await expect(titleMark).toBeVisible();
  expect(await titleMark.locator("svg").innerHTML()).toBe(sparkle);
  await expect(titleMark).toHaveAttribute("aria-label", /Created by Claude/);

  // A failed change rolls back instead of silently restoring the logos.
  await page.goto("/settings#appearance");
  await expect(toggle).toBeEnabled();
  await page.route("**/api/kv?collection=account-prefs", (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({ status: 500, body: "save failed" });
    return route.fallback();
  });
  await toggle.click();
  await expect(page.getByText(/Couldn't save AI app icons/)).toBeVisible();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await page.unroute("**/api/kv?collection=account-prefs");
  await toggle.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(toggle).toBeChecked();
  await page.getByRole("button", { name: "Back to outline" }).click();
  expect(await mark(page, "ai").locator("svg").innerHTML()).toBe(claudeLogo);
  expect(await mark(page, "amp").locator("svg").innerHTML()).not.toBe(
    claudeLogo,
  );

  // An account change from another tab/device is picked up on focus.
  await page.evaluate(async () => {
    const key = "appearance:ai-app-icons";
    const response = await fetch("/api/kv?collection=account-prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: [{ key, value: { key, enabled: false } }] }),
    });
    if (!response.ok) throw new Error("preference update failed");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(async () => {
    expect(await mark(page, "ai").locator("svg").innerHTML()).toBe(sparkle);
  }).toPass();
});
