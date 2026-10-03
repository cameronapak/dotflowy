import { expect, test } from "@playwright/test";

import type { Node } from "../src/data/wire-schema";

import {
  planClassicRecovery,
  planExperimentalPrimaryRecovery,
} from "../worker/lunora-recovery";
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

for (const authority of ["classic", "experimental"] as const) {
  for (const width of [1280, 390]) {
    test(`${authority}-primary recovery copies render and edit independently at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const current = node(
        "classic",
        authority === "classic"
          ? "My current Classic notes"
          : "My current experimental notes",
      );
      const alternativeText =
        authority === "classic"
          ? "Earlier experimental wording"
          : "Earlier Classic wording";
      const secondary = { ...current, text: alternativeText };
      const extraNode = node("extra", "Review the project outline", {
        parentId: authority === "classic" ? "missing-parent" : null,
        prevSiblingId: authority === "classic" ? null : current.id,
        isTask: true,
      });
      let counter = 0;
      const planner =
        authority === "classic"
          ? planClassicRecovery
          : planExperimentalPrimaryRecovery;
      const plan = planner(
        {
          version: 1,
          exportedAt: 10,
          seq: 3,
          nodes: authority === "classic" ? [current] : [secondary, extraNode],
          kv: [
            {
              collection: "account-prefs",
              key: "lunora-beta",
              value: JSON.stringify({ enabled: authority === "experimental" }),
              updatedAt: 10,
            },
          ],
        },
        {
          version: 1,
          exportedAt: 11,
          userId: "fixture",
          nodes: (authority === "classic"
            ? [secondary, extraNode]
            : [current]
          ).map((row) => ({ ...row, userId: "fixture" })),
          dailyIndex: [],
          tagColors: [],
          savedQueries: [],
          migrateState:
            authority === "classic"
              ? []
              : [{ userId: "fixture", nodesAt: 1, kvAt: 1 }],
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
      await seedOutline(page, [current, ...imported]);
      await page.goto("/");
      const text = (id: string) =>
        page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
      await expect(text(current.id)).toHaveText(current.text, {
        timeout: 15_000,
      });
      await expect(text(plan.rootId!)).toHaveText(
        authority === "classic"
          ? "Recovered experimental content"
          : "Recovered Classic content",
      );
      const alternative = imported.find(
        (value) => value.text === alternativeText,
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
        path: testInfo.outputPath(`recovery-${authority}-${width}.png`),
        fullPage: true,
      });
      await text(alternative.id).fill("Edited recovered alternative");
      await text(current.id).click();
      await expect(text(alternative.id)).toHaveText(
        "Edited recovered alternative",
      );
      await expect(text(current.id)).toHaveText(current.text);
      await page.reload();
      await expect(text(alternative.id)).toHaveText(
        "Edited recovered alternative",
      );
      await expect(text(current.id)).toHaveText(current.text);
    });
  }
}
