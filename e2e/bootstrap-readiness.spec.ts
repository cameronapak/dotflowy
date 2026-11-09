import { expect, test } from "@playwright/test";

import { openSeededOutline, seedOutline, text, type ApiNode } from "./fixtures";

test("navigation waits for the lazy editor before checking saved content", async ({
  page,
}) => {
  const store = await seedOutline(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "Anchor" },
    { id: "b", parentId: null, prevSiblingId: "a", text: "Before" },
  ]);
  // Arrange a saved backend change without booting the editor twice. The app
  // must read it after bootstrap; no earlier editor state can satisfy the check.
  const response = await page.goto("/api/nodes");
  const nodes: ApiNode[] = await response!.json();
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
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let held = false;
  // Hold this test's first lazy editor bootstrap, not the outline API read.
  await page.route(
    (url) => url.pathname === "/src/components/OutlineEditor.tsx",
    async (route) => {
      held = true;
      markEntered();
      await bootstrap;
      held = false;
      await route.fallback();
    },
    { times: 1 },
  );
  let ready = false;
  const opening = openSeededOutline(page, { anchorId: "a" }).then(() => {
    ready = true;
  });
  try {
    // Request arrival uses the test deadline, not the content assertion budget.
    await entered;
    // An ordinary 5s assertion cannot stand in for editor readiness. The
    // request must actually remain held, not merely be naturally slow.
    await expect(
      expect(text(page, "b")).toHaveText("Saved change"),
    ).rejects.toThrow();
    expect(held).toBe(true);
    expect(ready).toBe(false);
  } finally {
    release();
    await opening;
  }
  await expect(text(page, "b")).toHaveText("Saved change");
});
