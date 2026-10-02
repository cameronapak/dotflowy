import { expect, test } from "@playwright/test";

import type { Node } from "../src/data/wire-schema";

import { planClassicRecovery } from "../worker/lunora-recovery";
import { seedOutline } from "./fixtures";

test.use({ deviceScaleFactor: 2 });

const node = (id: string, text: string, fields: Partial<Node> = {}): Node => ({
  id,
  text,
  parentId: null,
  prevSiblingId: null,
  isTask: false,
  completed: false,
  collapsed: false,
  bookmarkedAt: null,
  mirrorOf: null,
  createdAt: 1,
  updatedAt: 2,
  origin: null,
  kind: null,
  ...fields,
});

for (const width of [1280, 390]) {
  test(`recovery copies render and edit independently at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const current = node("classic", "My current Classic notes");
    let counter = 0;
    const plan = planClassicRecovery(
      {
        version: 1,
        exportedAt: 10,
        seq: 3,
        nodes: [current],
        kv: [
          {
            collection: "account-prefs",
            key: "lunora-beta",
            value: '{"enabled":false}',
            updatedAt: 10,
          },
        ],
      },
      {
        version: 1,
        exportedAt: 11,
        userId: "fixture",
        nodes: [
          {
            ...current,
            text: "Earlier experimental wording",
            userId: "fixture",
          },
          {
            ...node("extra", "Review the project outline", {
              parentId: "missing-parent",
              isTask: true,
            }),
            userId: "fixture",
          },
        ],
        dailyIndex: [],
        tagColors: [],
        savedQueries: [],
        migrateState: [],
      },
      {
        userId: "fixture",
        timestamp: 12,
        newId: () => `n_recovery_${++counter}`,
      },
    );
    const imported = plan.nodes.map((value) =>
      value.id === plan.rootId
        ? { ...value, prevSiblingId: current.id }
        : value,
    );
    await seedOutline(page, [current, ...imported], { lunora: false });
    await page.goto("/");
    const text = (id: string) =>
      page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
    await expect(text(current.id)).toHaveText("My current Classic notes", {
      timeout: 15_000,
    });
    await expect(text(plan.rootId!)).toHaveText(
      "Recovered experimental content",
    );
    const alternative = imported.find(
      (value) => value.text === "Earlier experimental wording",
    )!;
    const extra = imported.find(
      (value) => value.text === "Review the project outline",
    )!;
    await expect(text(alternative.id)).toBeVisible();
    await expect(text(extra.id)).toBeVisible();
    await expect(
      page.locator(`li[data-node-id="${extra.id}"] > .outline-row .checkbox`),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`recovery-${width}.png`),
      fullPage: true,
    });
    await text(alternative.id).fill("Edited recovered alternative");
    await text(current.id).click();
    await expect(text(alternative.id)).toHaveText(
      "Edited recovered alternative",
    );
    await expect(text(current.id)).toHaveText("My current Classic notes");
    await page.reload();
    await expect(text(alternative.id)).toHaveText(
      "Edited recovered alternative",
    );
    await expect(text(current.id)).toHaveText("My current Classic notes");
  });
}
