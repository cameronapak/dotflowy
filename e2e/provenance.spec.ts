import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// The provenance plugin marks nodes an agent created via MCP (the write-once
// `origin` field) apart from what the user typed. The mark is a Seam F slot in
// both render paths (list bullet + zoomed title). This spec locks that a
// human-authored node stays unmarked, an agent-authored one shows the mark with
// its harness attribution, and the mark rides the zoom into the title.

const TREE: SeedNode[] = [
  { id: "mine", parentId: null, prevSiblingId: null, text: "i typed this" },
  {
    id: "ai",
    parentId: null,
    prevSiblingId: "mine",
    text: "an agent added this",
    origin: "Claude",
  },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const mark = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .provenance-mark`);

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(text(page, "mine")).toBeVisible();
}

test.describe("provenance marker", () => {
  test("marks an agent-created node and leaves the user's own unmarked", async ({
    page,
  }) => {
    await load(page);

    // The user's node carries no mark.
    await expect(mark(page, "mine")).toHaveCount(0);

    // The agent's node does, tagged with the harness name for the tooltip.
    const agentMark = mark(page, "ai");
    await expect(agentMark).toBeVisible();
    await expect(agentMark).toHaveAttribute("data-origin", "Claude");
    await expect(agentMark).toHaveAttribute("title", /Created by Claude/);
  });

  test("the mark rides the zoom into the page title (Seam F title slot)", async ({
    page,
  }) => {
    await load(page);

    // Zoom the agent node in by clicking its bullet dot.
    await page.locator(`li[data-node-id="ai"] .bullet`).first().click();

    // The zoomed title (registered under the rootId) shows the same mark.
    const titleMark = page.locator(`.zoomed-title .provenance-mark`);
    await expect(titleMark).toBeVisible();
    await expect(titleMark).toHaveAttribute("data-origin", "Claude");
  });
});
