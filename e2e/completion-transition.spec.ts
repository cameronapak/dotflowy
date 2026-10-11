import { expect, test, type Page } from "@playwright/test";

import { placeCaret, seedOutline, type SeedNode } from "./fixtures";

const TREE: SeedNode[] = [
  { id: "before", parentId: null, prevSiblingId: null, text: "Plan the week" },
  {
    id: "task",
    parentId: null,
    prevSiblingId: "before",
    text: "Send the project update",
    isTask: true,
  },
  {
    id: "child",
    parentId: "task",
    prevSiblingId: null,
    text: "Include the next milestone and the outstanding questions for the team. ".repeat(
      3,
    ),
  },
  {
    id: "after",
    parentId: null,
    prevSiblingId: "task",
    text: "Prepare tomorrow’s notes",
    isTask: true,
  },
];
const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);
const text = (page: Page, id: string) => row(page, id).locator(".node-text");

async function load(
  page: Page,
  nodes = TREE,
  showCompleted = false,
  path = "/",
) {
  await page.addInitScript(
    (show) => localStorage.setItem("dotflowy:show-completed", String(show)),
    showCompleted,
  );
  await seedOutline(page, nodes);
  await page.goto(path);
  await expect(text(page, "task")).toBeVisible({ timeout: 15_000 });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
}

test("keyboard completion shows the checked subtree, fades, closes the measured gap, and hands off focus", async ({
  page,
}) => {
  await load(page);
  const taskTop = (await row(page, "task").boundingBox())!.y;
  const afterTop = (await row(page, "after").boundingBox())!.y;
  const add = page.getByRole("button", { name: "Add node", exact: true });
  const addTop = (await add.boundingBox())!.y;
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(row(page, "task")).toHaveAttribute(
    "data-completion-exit",
    "true",
  );
  await expect(text(page, "task")).toHaveAttribute("data-completed", "true");
  await expect(row(page, "task").locator(".checkbox")).toBeChecked();
  await expect(row(page, "child")).toHaveAttribute(
    "data-completion-exit",
    "true",
  );
  await page.clock.runFor(79);
  await expect(text(page, "task")).toBeFocused();
  expect(
    await row(page, "after").evaluate((el) => el.getAnimations().length),
  ).toBe(0);

  await page.clock.runFor(1);
  await expect(text(page, "after")).toBeFocused();
  // Inspect rendered geometry at known animation times, including wrapped
  // subtree height and the handoff to the final virtualizer positions.
  await page.evaluate(() => {
    for (const li of document.querySelectorAll(
      "li[data-node-id], [data-outline-add]",
    )) {
      for (const animation of li.getAnimations()) {
        animation.pause();
        animation.currentTime = li.hasAttribute("data-completion-exit")
          ? 40
          : -40;
      }
    }
  });
  const opacity = await row(page, "task").evaluate((el) =>
    Number(getComputedStyle(el).opacity),
  );
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  expect((await row(page, "after").boundingBox())!.y).toBeCloseTo(afterTop, 2);
  expect((await add.boundingBox())!.y).toBeCloseTo(addTop, 2);
  await page.evaluate(() => {
    for (const li of document.querySelectorAll(
      "li[data-node-id], [data-outline-add]",
    ))
      for (const animation of li.getAnimations())
        animation.currentTime = li.hasAttribute("data-completion-exit")
          ? 80
          : 40;
  });
  expect(
    await row(page, "child").evaluate((el) =>
      Number(getComputedStyle(el).opacity),
    ),
  ).toBe(0);
  const movingTop = (await row(page, "after").boundingBox())!.y;
  expect(movingTop).toBeGreaterThan(taskTop);
  expect(movingTop).toBeLessThan(afterTop);
  await page.evaluate(() => {
    for (const li of document.querySelectorAll(
      "li[data-node-id], [data-outline-add]",
    ))
      for (const animation of li.getAnimations()) animation.currentTime = 80;
  });
  expect((await row(page, "after").boundingBox())!.y).toBeCloseTo(taskTop, 0);
  expect((await add.boundingBox())!.y).toBeCloseTo(
    addTop - (afterTop - taskTop),
    0,
  );
  await page.clock.runFor(160);
  await expect(row(page, "task")).toHaveCount(0);
  await expect(row(page, "child")).toHaveCount(0);
  expect((await row(page, "after").boundingBox())!.y).toBeCloseTo(taskTop, 0);
  expect((await add.boundingBox())!.y).toBeCloseTo(
    addTop - (afterTop - taskTop),
    0,
  );
  await page.reload();
  await expect(row(page, "task")).toHaveCount(0);
});

test("native animation frames move surviving rows and Add node before the subtree disappears", async ({
  page,
}) => {
  await load(page);
  await page.clock.resume();
  const frames = await page.evaluate(async () => {
    const task = document.querySelector<HTMLElement>(
      'li[data-node-id="task"]',
    )!;
    const after = document.querySelector<HTMLElement>(
      'li[data-node-id="after"]',
    )!;
    const add = document.querySelector<HTMLElement>("[data-outline-add]")!;
    const targetY = task.getBoundingClientRect().y;
    const initialY = after.getBoundingClientRect().y;
    const addY = add.getBoundingClientRect().y;
    const gap = initialY - targetY;
    const samples: {
      rowProgress: number;
      addProgress: number;
      opacity: number;
      present: boolean;
    }[] = [];
    task.querySelector<HTMLInputElement>(".checkbox")!.click();
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      samples.push({
        rowProgress: (initialY - after.getBoundingClientRect().y) / gap,
        addProgress: (addY - add.getBoundingClientRect().y) / gap,
        opacity: Number(getComputedStyle(task).opacity),
        present: task.isConnected,
      });
      if (!task.isConnected) break;
    }
    return samples;
  });
  // No manual animation seeking. A final layout snap without native motion
  // cannot produce an intermediate frame or nearly close the gap before removal.
  expect(frames.some((f) => f.present && f.opacity > 0 && f.opacity < 1)).toBe(
    true,
  );
  expect(
    frames.some((f) => f.present && f.rowProgress > 0.1 && f.rowProgress < 0.9),
  ).toBe(true);
  // Moving through a still-visible wrapped descendant makes the text overlap.
  // Finish the fade before closing its gap, including on native compositor time.
  expect(
    frames
      .filter((f) => f.present && f.opacity > 0.001)
      .every(
        (f) =>
          Math.abs(f.rowProgress) < 0.001 && Math.abs(f.addProgress) < 0.001,
      ),
    JSON.stringify(frames),
  ).toBe(true);
  expect(
    frames.some((f) => f.present && f.rowProgress > 0.9 && f.addProgress > 0.9),
    JSON.stringify(frames),
  ).toBe(true);
  expect(frames.at(-1)?.present).toBe(false);
  expect(frames.at(-1)?.rowProgress).toBeCloseTo(1, 2);
  expect(frames.at(-1)?.addProgress).toBeCloseTo(1, 2);
});

test("checkbox completion uses the same exit and undo during the fade restores interaction", async ({
  page,
}) => {
  await load(page);
  await row(page, "task").locator(".checkbox").click();
  await expect(row(page, "task")).toHaveAttribute(
    "data-completion-exit",
    "true",
  );
  await page.clock.runFor(100);
  await expect(text(page, "after")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  // History replay now yields before draining writes; the paused clock must
  // advance its scheduler as well as the completion presentation timeout.
  await page.clock.runFor(32);
  await expect(text(page, "task")).toHaveAttribute("data-completed", "false");
  await expect(row(page, "task")).not.toHaveAttribute("data-completion-exit");
  expect(
    await row(page, "task").evaluate(
      (el) => el instanceof HTMLElement && el.inert,
    ),
  ).toBe(false);
  await page.clock.runFor(400);
  await expect(text(page, "task")).toBeVisible();
  await expect(text(page, "child")).toBeVisible();
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+d");
  await page.clock.runFor(240);
  await expect(row(page, "task")).toHaveCount(0);
});

test("inserting a surviving row during an exit keeps its pending focus", async ({
  page,
}) => {
  await load(page);
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.clock.runFor(100);
  await expect(text(page, "after")).toBeFocused();
  await placeCaret(text(page, "after"), "end");
  await page.keyboard.press("Enter");
  await page.clock.runFor(32);
  const inserted = page.locator(".node-text:focus");
  await expect(inserted).toHaveText("");
  await expect(inserted).not.toHaveAttribute("data-history-key", "after");
  await expect(row(page, "task")).toBeAttached();
  await page.clock.runFor(108);
  await expect(row(page, "task")).toHaveCount(0);
  await expect(page.locator("li[data-node-id]")).toHaveCount(3);
  await expect(inserted).toHaveText("");
});

test("switching hide completed on hides all completed subtrees together and keeps surviving focus", async ({
  page,
}) => {
  await load(
    page,
    TREE.map((n) =>
      n.id === "task" || n.id === "after" ? { ...n, completed: true } : n,
    ),
    true,
  );
  await text(page, "before").focus();
  await page.evaluate(() => {
    localStorage.setItem("dotflowy:show-completed", "false");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "dotflowy:show-completed" }),
    );
  });
  await expect(page.locator("[data-completion-exit]")).toHaveCount(3);
  await page.clock.runFor(80);
  await expect(text(page, "before")).toBeFocused();
  const starts = await page
    .locator("[data-completion-exit]")
    .evaluateAll((els) => els.map((el) => el.getAnimations()[0]?.startTime));
  expect(starts.every((start) => start === starts[0])).toBe(true);
  await page.clock.runFor(160);
  await expect(page.locator("li[data-node-id]")).toHaveCount(1);
});

test("re-enabling show completed interrupts an exit without leaving inert rows", async ({
  page,
}) => {
  await load(page);
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.clock.runFor(100);
  await page.evaluate(() => {
    localStorage.setItem("dotflowy:show-completed", "true");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "dotflowy:show-completed" }),
    );
  });
  await expect(row(page, "task")).not.toHaveAttribute("data-completion-exit");
  await page.clock.runFor(300);
  await expect(text(page, "task")).toBeVisible();
  expect(
    await row(page, "task").evaluate(
      (el) => el instanceof HTMLElement && el.inert,
    ),
  ).toBe(false);
});

test("reduced motion removes immediately and focuses the previous surviving row", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await load(
    page,
    TREE.filter((n) => n.id !== "after"),
  );
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(row(page, "task")).toHaveCount(0);
  await expect(row(page, "child")).toHaveCount(0);
  await expect(text(page, "before")).toBeFocused();
  expect(
    await row(page, "before").evaluate((el) => el.getAnimations().length),
  ).toBe(0);
});

test("completing the last Home node lands on Add node", async ({ page }) => {
  await load(page, [{ ...TREE[1]!, prevSiblingId: null }]);
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.clock.runFor(240);
  await expect(
    page.getByRole("button", { name: "Add node", exact: true }),
  ).toBeFocused();
});

test("completing the last child lands on the zoomed title", async ({
  page,
}) => {
  await load(
    page,
    [{ ...TREE[0]! }, { ...TREE[1]!, parentId: "before", prevSiblingId: null }],
    false,
    "/before",
  );
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.clock.runFor(240);
  await expect(page.locator(".zoomed-title .node-text")).toBeFocused();
});

test("collapse stays instant rather than using the completion exit", async ({
  page,
}) => {
  await load(page);
  await row(page, "task")
    .getByRole("button", { name: "Collapse", exact: true })
    .click();
  await expect(row(page, "child")).toHaveCount(0);
  await expect(page.locator("[data-completion-exit]")).toHaveCount(0);
});

test("a sync-only completion animates every mirror instance without stealing surviving focus", async ({
  page,
}) => {
  await load(page, [
    ...TREE,
    {
      id: "mirror",
      parentId: null,
      prevSiblingId: "after",
      text: "",
      mirrorOf: "task",
    },
  ]);
  await text(page, "before").focus();
  // No local collection mutation or completion command. The mock server
  // broadcasts this write over /api/sync, like completion on another device.
  await page.evaluate(async () => {
    const response = await fetch("/api/nodes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updates: [{ id: "task", changes: { completed: true } }],
      }),
    });
    if (!response.ok) throw new Error("Sync fixture write failed");
  });
  // Let the sync fiber's scheduled work drain without reaching the 80ms hold.
  await page.clock.runFor(16);
  await expect(page.locator("[data-completion-exit]")).toHaveCount(4);
  await page.clock.runFor(80);
  await expect(text(page, "before")).toBeFocused();
  expect(
    await row(page, "mirror").evaluate((el) => el.getAnimations().length),
  ).toBe(1);
  await page.clock.runFor(160);
  await expect(row(page, "task")).toHaveCount(0);
  await expect(row(page, "mirror")).toHaveCount(0);
  await expect(row(page, "child")).toHaveCount(0);
});

test("a large disappearing subtree stays windowed and hands focus to an initially unmounted neighbor", async ({
  page,
}) => {
  const children: SeedNode[] = Array.from({ length: 250 }, (_, i) => ({
    id: `child-${i}`,
    parentId: "task",
    prevSiblingId: i === 0 ? null : `child-${i - 1}`,
    text: `Step ${i}`,
  }));
  await load(page, [...TREE.filter((n) => n.id !== "child"), ...children]);
  const targetTop = (await row(page, "task").boundingBox())!.y;
  await expect(row(page, "after")).toHaveCount(0);
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(row(page, "task")).toHaveAttribute(
    "data-completion-exit",
    "true",
  );
  expect(await page.locator("li[data-node-id]").count()).toBeLessThan(100);
  await page.clock.runFor(112);
  await expect(text(page, "after")).toBeFocused();
  await row(page, "after").evaluate((el) => {
    const animation = el.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 160;
  });
  expect(
    await row(page, "after").evaluate(
      (el) => el.getBoundingClientRect().y + window.scrollY,
    ),
  ).toBeCloseTo(targetTop, 0);
  await page.clock.runFor(208);
  await expect(text(page, "after")).toBeFocused();
  await expect(page.locator("li[data-node-id]")).toHaveCount(2);
});

test("changing the query does not animate removed matches", async ({
  page,
}) => {
  await load(page);
  await page.keyboard.press("ControlOrMeta+f");
  await page.clock.runFor(32);
  await page.getByRole("combobox", { name: "Filter query" }).fill("Plan");
  await page.clock.runFor(500);
  await expect(page).toHaveURL(/q=Plan/);
  await expect(row(page, "task")).toHaveCount(0);
  await expect(page.locator("[data-completion-exit]")).toHaveCount(0);
  expect(
    await row(page, "before").evaluate((el) => el.getAnimations().length),
  ).toBe(0);
});

test("typing in a surviving filtered task does not restart an exit", async ({
  page,
}) => {
  await load(page, TREE, false, "/?q=is%3Atodo");
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.clock.runFor(100);
  await row(page, "task").evaluate((el) => {
    const animation = el.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 80;
  });
  const opacity = await row(page, "task").evaluate(
    (el) => getComputedStyle(el).opacity,
  );
  for (const letter of "abc") {
    await page.keyboard.type(letter);
    await page.clock.runFor(30);
    expect(
      await row(page, "task").evaluate(
        (el) => el instanceof HTMLElement && el.inert,
      ),
    ).toBe(true);
    expect(
      await row(page, "task").evaluate((el) => getComputedStyle(el).opacity),
    ).toBe(opacity);
  }
  await page.clock.runFor(50);
  await expect(row(page, "task")).toHaveCount(0);
  await expect(text(page, "after")).toBeFocused();
});

test("overlapping completions keep independent deadlines without snapping a moving row", async ({
  page,
}) => {
  await load(page, [
    ...TREE,
    {
      id: "last",
      parentId: null,
      prevSiblingId: "after",
      text: "Keep this node",
    },
  ]);
  const taskTop = (await row(page, "task").boundingBox())!.y;
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.clock.runFor(100);
  await row(page, "after").evaluate((el) => {
    const animation = el.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 40;
  });
  const movingTop = (await row(page, "after").boundingBox())!.y;
  expect(movingTop).toBeGreaterThan(taskTop);
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.clock.runFor(80);
  expect((await row(page, "after").boundingBox())!.y).toBeCloseTo(movingTop, 2);
  expect(
    await row(page, "after").evaluate((el) => el.getAnimations().length),
  ).toBe(2);
  await page.clock.runFor(60);
  await expect(row(page, "task")).toHaveCount(0);
  await expect(row(page, "after")).toBeAttached();
  await page.clock.runFor(100);
  await expect(row(page, "after")).toHaveCount(0);
  await expect(text(page, "last")).toBeFocused();
  expect((await row(page, "last").boundingBox())!.y).toBeCloseTo(taskTop, 0);
});

test("late-mounted exiting rows join the fade and cannot take focus", async ({
  page,
}) => {
  const children: SeedNode[] = Array.from({ length: 250 }, (_, i) => ({
    id: `child-${i}`,
    parentId: "task",
    prevSiblingId: i ? `child-${i - 1}` : null,
    text: `Step ${i}`,
  }));
  await load(page, [...TREE.filter((n) => n.id !== "child"), ...children]);
  await text(page, "before").focus();
  await page.evaluate(() =>
    document
      .querySelector<HTMLInputElement>('li[data-node-id="task"] .checkbox')!
      .click(),
  );
  await page.clock.runFor(120);
  // Observe the mount synchronously, before native compositor time can run
  // beyond the paused test clock. A freshly restarted fade would be at 0ms,
  // not at least 40ms into the existing exit, and would still be opaque.
  const mounted = page.evaluate(
    () =>
      new Promise<{ elapsed: number; opacity: number; inert: boolean }>(
        (resolve) => {
          const observer = new MutationObserver(() => {
            const li = document.querySelector<HTMLElement>(
              'li[data-node-id="child-100"]',
            );
            if (!li) return;
            const elapsed = Number(li.getAnimations()[0]?.currentTime ?? 0);
            for (const row of document.querySelectorAll("li[data-node-id]"))
              for (const animation of row.getAnimations()) animation.pause();
            resolve({
              elapsed,
              opacity: Number(getComputedStyle(li).opacity),
              inert: li.inert,
            });
            observer.disconnect();
          });
          observer.observe(document.querySelector(".outline-list")!, {
            childList: true,
          });
          window.scrollTo(0, 3500);
        },
      ),
  );
  await page.clock.runFor(32);
  const joined = await mounted;
  expect(joined.elapsed).toBeGreaterThanOrEqual(40);
  expect(joined.opacity).toBeGreaterThan(0);
  expect(joined.opacity).toBeLessThan(0.5);
  expect(joined.inert).toBe(true);
  const late = row(page, "child-100");
  await expect(late).toBeAttached();
  expect(
    await late.evaluate((el) => el instanceof HTMLElement && el.inert),
  ).toBe(true);
  expect(
    await late.evaluate((el) => Number(getComputedStyle(el).opacity)),
  ).toBeLessThan(0.5);
  await late.locator(".node-text").evaluate((el) => {
    if (el instanceof HTMLElement) el.focus();
  });
  await expect(late.locator(".node-text")).not.toBeFocused();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.clock.runFor(32);
  expect(
    await row(page, "task").evaluate(
      (el) => el instanceof HTMLElement && el.inert,
    ),
  ).toBe(true);
  await page.clock.runFor(56);
  await expect(row(page, "task")).toHaveCount(0);
  await expect(row(page, "after")).toBeVisible();
});

test("collapse during a child's completion exit removes its presentation immediately", async ({
  page,
}) => {
  await load(page, [
    ...TREE.map((n) =>
      n.id === "task"
        ? { ...n, parentId: "before", prevSiblingId: null }
        : n.id === "after"
          ? { ...n, prevSiblingId: "before" }
          : n,
    ),
    {
      id: "remaining",
      parentId: "before",
      prevSiblingId: "task",
      text: "Still visible",
    },
  ]);
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.clock.runFor(100);
  await row(page, "before")
    .getByRole("button", { name: "Collapse", exact: true })
    .click();
  await expect(row(page, "task")).toHaveCount(0);
  await expect(row(page, "child")).toHaveCount(0);
  await expect(page.locator("[data-completion-exit]")).toHaveCount(0);
});

test("deleting an exiting mirror removes its render path without restarting the source exit", async ({
  page,
}) => {
  await load(page, [
    ...TREE,
    {
      id: "mirror",
      parentId: null,
      prevSiblingId: "after",
      text: "",
      mirrorOf: "task",
    },
  ]);
  await text(page, "task").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.clock.runFor(100);
  await page.evaluate(async () => {
    const response = await fetch("/api/nodes", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["mirror"] }),
    });
    if (!response.ok) throw new Error("Fixture delete failed");
  });
  await page.clock.runFor(16);
  await expect(row(page, "mirror")).toHaveCount(0);
  await expect(row(page, "child")).toHaveCount(1);
  await page.clock.runFor(124);
  await expect(row(page, "task")).toHaveCount(0);
  await expect(row(page, "child")).toHaveCount(0);
});
