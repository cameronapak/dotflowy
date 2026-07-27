import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  seedOutlineLunora,
  waitForSeededNode,
} from "./fixtures";

/**
 * Inline `@agent` (ADR 0059) on the Lunora path. The mock implements
 * `agent:fireAgentRun` with a canned stream + commit (no real Workers AI).
 */

/** Two-step fire: hotkey opens confirm; ▶ Run starts the action. */
async function confirmRunFromHotkey(page: Page) {
  await page.keyboard.press("Meta+Shift+Enter");
  const dialog = page.getByRole("dialog", { name: "Run agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "▶ Run" }).click();
}

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
    await confirmRunFromHotkey(page);

    // Windowed list: children are flat `li`s keyed by data-parent-id.
    await expect(
      page.locator('li[data-parent-id="q1"] .node-text').first(),
    ).toHaveText("Mock agent summary.", { timeout: 15_000 });

    const summaryId = await page
      .locator('li[data-parent-id="q1"]')
      .first()
      .getAttribute("data-node-id");
    expect(summaryId).toBeTruthy();

    // ADR 0059 Volume: summary arrives collapsed when detail exists.
    const expand = page.locator(
      `li[data-node-id="${summaryId}"] button.collapse-toggle[aria-label="Expand"]`,
    );
    await expect(expand).toBeVisible();
    await expand.click();

    await expect(
      page.locator(`li[data-parent-id="${summaryId}"] .node-text`),
    ).toHaveText("Detail line from the e2e Workers AI stub.");
  });

  test("trailing loader while run is delayed then completes", async ({
    page,
  }) => {
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
    await confirmRunFromHotkey(page);

    const row = page.locator('li[data-node-id="q2"]');
    await expect(row.locator("[data-agent-loader]")).toBeVisible({
      timeout: 5_000,
    });
    await expect(row.locator("[data-agent-stop]")).toBeVisible();
    await expect(row.locator("[data-agent-play]")).toHaveCount(0);
    await waitForSeededNode(page, "q2");
    await expect(
      page.locator('li[data-parent-id="q2"] .node-text').first(),
    ).toHaveText("Mock agent summary.", { timeout: 15_000 });
    await expect(row.locator("[data-agent-loader]")).toHaveCount(0);
    await expect(row.locator("[data-agent-play]")).toBeVisible();
  });

  test("Stop cancels the server run — no answer lands", async ({ page }) => {
    await seedOutlineLunora(
      page,
      [
        {
          id: "q-stop",
          parentId: null,
          prevSiblingId: null,
          text: "@agent please cancel me",
        },
      ],
      // Long enough to click Stop while the mock is still "streaming".
      { agentFireDelayMs: 2_500 },
    );
    await openSeededOutline(page, { anchorId: "q-stop" });

    const text = page.locator('li[data-node-id="q-stop"] .node-text');
    await text.click();
    await confirmRunFromHotkey(page);

    const row = page.locator('li[data-node-id="q-stop"]');
    await expect(row.locator("[data-agent-stop]")).toBeVisible({
      timeout: 5_000,
    });

    // Regression: cancel must hit the Worker via client.mutation
    // (`mutators:cancelAgentRunForQuestion`), not only clear a local overlay.
    const cancelHit = page.waitForRequest((req) => {
      if (!req.url().includes("/_lunora/rpc")) return false;
      try {
        const body = req.postDataJSON() as { functionPath?: string };
        return body.functionPath === "mutators:cancelAgentRunForQuestion";
      } catch {
        return false;
      }
    });

    await row.locator("[data-agent-stop]").click();
    await cancelHit;

    await expect(row.locator("[data-agent-loader]")).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(row.locator("[data-agent-play]")).toBeVisible();

    // Hold through the mock delay window — a cancelled run must never commit.
    await expect(async () => {
      expect(await page.locator('li[data-parent-id="q-stop"]').count()).toBe(0);
    }).toPass({ timeout: 4_000 });
  });

  test("play opens Run popover then fires", async ({ page }) => {
    await seedOutlineLunora(page, [
      {
        id: "q3",
        parentId: null,
        prevSiblingId: null,
        text: "@agent via play",
      },
    ]);
    await openSeededOutline(page, { anchorId: "q3" });

    await page.locator('li[data-node-id="q3"] [data-agent-play]').click();
    const dialog = page.getByRole("dialog", { name: "Run agent" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "▶ Run" }).click();
    await expect(
      page.locator('li[data-parent-id="q3"] .node-text').first(),
    ).toHaveText("Mock agent summary.", { timeout: 15_000 });
  });
});
