import { expect, test } from "@playwright/test";

import {
  openSeededOutline,
  seedOutlineLunora,
  waitForSeededNode,
} from "./fixtures";

/**
 * Inline `@agent` (ADR 0059) on the Lunora path. The mock implements
 * `agent:fireAgentRun` with a canned stream + commit (no real Workers AI).
 */

test.describe("inline @agent (Lunora)", () => {
  test("Mod+Shift+Enter commits summary + detail children", async ({
    page,
  }) => {
    await seedOutlineLunora(page, [
      {
        id: "q1",
        parentId: null,
        prevSiblingId: null,
        text: "@agent what should I do next?",
      },
    ]);
    await openSeededOutline(page, { anchorId: "q1" });

    const text = page.locator('li[data-node-id="q1"] .node-text');
    await text.click();
    await page.keyboard.press("Meta+Shift+Enter");

    // Windowed list: children are flat `li`s keyed by data-parent-id.
    await expect(
      page.locator('li[data-parent-id="q1"] .node-text').first(),
    ).toHaveText("Mock agent summary.", { timeout: 15_000 });

    const summaryId = await page
      .locator('li[data-parent-id="q1"]')
      .first()
      .getAttribute("data-node-id");
    expect(summaryId).toBeTruthy();

    await expect(
      page.locator(`li[data-parent-id="${summaryId}"] .node-text`),
    ).toHaveText("Detail line from the e2e Workers AI stub.");
  });

  test("ghost text appears while run is delayed", async ({ page }) => {
    await seedOutlineLunora(
      page,
      [
        {
          id: "q2",
          parentId: null,
          prevSiblingId: null,
          text: "@agent stream please",
        },
      ],
      { agentFireDelayMs: 800 },
    );
    await openSeededOutline(page, { anchorId: "q2" });

    const text = page.locator('li[data-node-id="q2"] .node-text');
    await text.click();
    await page.keyboard.press("Meta+Shift+Enter");

    await expect(page.locator("[data-agent-ghost]")).toBeVisible({
      timeout: 5_000,
    });
    await waitForSeededNode(page, "q2");
    await expect(
      page.locator('li[data-parent-id="q2"] .node-text').first(),
    ).toHaveText("Mock agent summary.", { timeout: 15_000 });
    await expect(page.locator("[data-agent-ghost]")).toHaveCount(0);
  });
});
