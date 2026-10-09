import { expect, test } from "@playwright/test";

import { openSeededOutline, seedOutline, type SeedNode } from "./fixtures";

const TREE: SeedNode[] = [
  {
    id: "classic",
    parentId: null,
    prevSiblingId: null,
    text: "Classic outline",
  },
];

test("stale experimental preferences cannot bypass Classic sync", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("dotflowy:flag:lunora-sync", "on");
  });
  await seedOutline(page, TREE, {
    kv: {
      "account-prefs": [
        { key: "lunora-beta", value: { id: "lunora-beta", enabled: true } },
      ],
    },
  });

  const experimentalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/_lunora")) {
      experimentalRequests.push(request.url());
    }
  });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/_lunora")) {
      experimentalRequests.push(socket.url());
    }
  });

  await openSeededOutline(page, {
    path: "/?lunora-sync=on",
    anchorId: "classic",
  });
  const text = page.locator(
    'li[data-node-id="classic"] > .outline-row .node-text',
  );
  await expect(text).toHaveText("Classic outline");

  await page.goto("/settings?lunora-sync=on");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Upgraded outline sync beta" }),
  ).toHaveCount(0);

  await openSeededOutline(page, {
    path: "/?lunora-sync=on",
    anchorId: "classic",
  });
  await text.click();
  await text.press("End");
  await page.keyboard.type(" edited");
  await expect(text).toHaveText("Classic outline edited");
  await page.reload();
  await expect(text).toHaveText("Classic outline edited");
  expect(experimentalRequests).toEqual([]);
});
