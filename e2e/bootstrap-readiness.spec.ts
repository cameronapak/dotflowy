import { expect, test } from "@playwright/test";

import { openSeededOutline, seedOutline, text, type ApiNode } from "./fixtures";

test("navigation waits for the lazy editor before checking saved content", async ({
  page,
}) => {
  const store = await seedOutline(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "Anchor" },
    { id: "b", parentId: null, prevSiblingId: "a", text: "Before" },
  ]);
  await openSeededOutline(page, { anchorId: "a" });
  const nodes: ApiNode[] = await page.evaluate(async () =>
    (await fetch("/api/nodes")).json(),
  );
  await store.injectExternalChange([
    {
      op: "update",
      value: {
        ...nodes.find((node) => node.id === "b")!,
        text: "Saved change",
      },
    },
  ]);

  let release!: () => void;
  const bootstrap = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  // Install after the initial mount; hold only this test's next lazy bootstrap.
  await page.route(
    (url) => url.pathname === "/src/components/OutlineEditor.tsx",
    async (route) => {
      held = true;
      await bootstrap;
      held = false;
      await route.fallback();
    },
    { times: 1 },
  );
  let ready = false;
  const reopening = openSeededOutline(page, { anchorId: "a" }).then(() => {
    ready = true;
  });
  try {
    await expect.poll(() => held).toBe(true);
    // An ordinary 5s assertion cannot stand in for editor readiness. The
    // request must actually remain held, not merely be naturally slow.
    await expect(
      expect(text(page, "b")).toHaveText("Saved change"),
    ).rejects.toThrow();
    expect(held).toBe(true);
    expect(ready).toBe(false);
  } finally {
    release();
    await reopening;
  }
  await expect(text(page, "b")).toHaveText("Saved change");
});
