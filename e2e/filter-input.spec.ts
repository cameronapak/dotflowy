import { expect, test, type Page } from "@playwright/test";

import {
  applyFilter,
  filterPill,
  findInput,
  openSeededOutline,
  placeCaret,
  seedOutline,
  type SeedNode,
} from "./fixtures";

// The `?q=` filter (ADR 0047 §6, ADR 0089): Find is the one search box. Cmd+F
// opens it on the current node, Shift+Enter or Show in outline writes `?q=`,
// and a subheader pill keeps the applied query visible while you edit the live
// outline. The pill reopens Find prefilled; its X clears the filter.

const TREE: SeedNode[] = [
  {
    id: "milk",
    parentId: null,
    prevSiblingId: null,
    text: "Buy milk #work",
    isTask: true,
  },
  { id: "mom", parentId: null, prevSiblingId: "milk", text: "Call mom" },
  {
    id: "ship",
    parentId: null,
    prevSiblingId: "mom",
    text: "Ship it #work",
  },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);

async function load(page: Page) {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "milk" });
}

test("the pill shows the applied query and reopens Find on this node", async ({
  page,
}) => {
  await seedOutline(page, [
    ...TREE,
    { id: "detail", parentId: "mom", prevSiblingId: null, text: "Call #work" },
    { id: "plain", parentId: "mom", prevSiblingId: "detail", text: "Notes" },
  ]);
  await openSeededOutline(page, { path: "/mom", anchorId: "detail" });
  // No filter: no pill and no header funnel; Find is the only search box.
  await expect(filterPill(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Filter this view" }),
  ).toHaveCount(0);

  await applyFilter(page, "#work");
  // Focus lands on the applied filter, not on a bullet it may hide.
  await expect(filterPill(page)).toBeFocused();
  await expect(row(page, "detail")).toBeVisible();
  await expect(row(page, "plain")).toHaveCount(0);
  await expect(filterPill(page)).toHaveText("#workin this node");

  // The pill reopens Find with the query, scoped to this node.
  await filterPill(page).click();
  await expect(findInput(page)).toHaveValue("#work");
  await expect(
    page.getByRole("button", { name: /^This node/, pressed: true }),
  ).toBeVisible();
  await expect(page.locator('[data-result-id="detail"]')).toBeVisible();
  // Escape leaves the applied filter alone.
  await page.keyboard.press("Escape");
  await expect(findInput(page)).toHaveCount(0);
  await expect(page).toHaveURL(/q=%23work/);

  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(filterPill(page)).toHaveCount(0);
  await expect(row(page, "plain")).toBeVisible();
});

test("Show in outline applies Find's query to the view", async ({ page }) => {
  await load(page);
  await page.keyboard.press("ControlOrMeta+f");
  // Home has no narrower place, so Find searches Everywhere.
  await expect(page.getByRole("button", { name: /^This node/ })).toHaveCount(0);

  // `is:todo` (a core operator) keeps the task, prunes the plain bullets.
  await findInput(page).fill("is:todo");
  await page.getByRole("button", { name: /^Show in outline/ }).click();

  await expect(findInput(page)).toHaveCount(0);
  await expect(row(page, "milk").first()).toBeVisible();
  await expect(row(page, "mom")).toHaveCount(0);
  await expect(row(page, "ship")).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]q=is/);
  await expect(filterPill(page)).toHaveText("is:todoin Home");
});

test("an empty local filter opens Find everywhere without changing the route", async ({
  page,
}) => {
  await seedOutline(page, [
    ...TREE,
    {
      id: "detail",
      parentId: "mom",
      prevSiblingId: null,
      text: "Call details",
    },
  ]);
  await openSeededOutline(page, { path: "/mom", anchorId: "detail" });
  await applyFilter(page, "#work");
  await expect(row(page, "detail")).toHaveCount(0);
  const escape = page.getByRole("button", {
    name: "Find everywhere",
    exact: true,
  });
  await expect(escape).toBeVisible();
  const origin = page.url();
  await escape.click();
  await expect(
    page.getByRole("combobox", { name: "Find nodes and actions" }),
  ).toHaveValue("#work");
  await expect(page.locator('[data-result-id="milk"]')).toBeVisible();
  await expect(page.locator('[data-result-id="ship"]')).toBeVisible();
  await expect(page).toHaveURL(origin);
});

test("empty-filter recovery ranks useful removals and protects OR operands", async ({
  page,
}) => {
  await load(page);
  await applyFilter(page, '#work "Call mom"');
  const empty = page.getByRole("region", { name: "No filter matches" });
  await expect(empty.getByRole("heading")).toHaveText("No matches");
  const removals = empty.getByRole("button", { name: /^Remove / });
  // Dropping the phrase restores both tagged rows; dropping the tag restores mom.
  await expect(removals).toHaveText([
    'Remove ""Call mom""2',
    'Remove "#work"1',
  ]);
  await expect(
    empty.getByRole("button", { name: /^Show completed/ }),
  ).toHaveCount(0);
  await removals.first().click();
  await expect(filterPill(page)).toContainText("#work");
  await expect(row(page, "milk")).toBeVisible();
  await expect(row(page, "ship")).toBeVisible();

  await applyFilter(page, "milk OR mom missing");
  await expect(removals).toHaveText(['Remove "missing"2']);
  await removals.first().click();
  await expect(filterPill(page)).toContainText("milk OR mom");
  await expect(row(page, "milk")).toBeVisible();
  await expect(row(page, "mom")).toBeVisible();

  // Removing mom would also unlock results by changing the OR grouping. Only
  // the independent milk term is safe to offer.
  await applyFilter(page, "milk mom OR ship");
  await expect(removals).toHaveText(['Remove "milk"2']);
  // A sole token defers to Clear filter, rather than a duplicate action.
  await applyFilter(page, "missing");
  await expect(page).toHaveURL(/q=missing/);
  await expect(empty).toBeVisible();
  await expect(removals).toHaveCount(0);
  await empty.getByRole("button", { name: /^Clear filter/ }).click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(row(page, "mom")).toBeVisible();
});

test("a free-text term filters by substring", async ({ page }) => {
  await load(page);
  await applyFilter(page, "milk");

  await expect(row(page, "milk").first()).toBeVisible();
  await expect(row(page, "mom")).toHaveCount(0);
  await expect(row(page, "ship")).toHaveCount(0);
});

for (const query of ["#work", "work"]) {
  test(`editing out ${query} keeps focus until moving to another row`, async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await openSeededOutline(page, {
      path: `/?q=${encodeURIComponent(query)}`,
      anchorId: "milk",
    });
    const editor = row(page, "milk").locator(".node-text");
    await placeCaret(editor, "end");
    await editor.press("Backspace");

    await expect(editor).toHaveText("Buy milk #wor");
    await expect(editor).toBeFocused();
    await expect(row(page, "mom")).toHaveCount(0);
    // Continue typing after crossing the matching boundary.
    await editor.press("Backspace");
    await expect(editor).toHaveText("Buy milk #wo");
    await expect(editor).toBeFocused();

    await editor.press("Escape"); // close tag autocomplete before navigating
    await editor.press("ArrowDown");
    await expect(row(page, "ship").locator(".node-text")).toBeFocused();
    await expect(row(page, "milk")).toHaveCount(0);
    await expect(filterPill(page)).toContainText(query);
  });
}

test("editing the last match keeps the row until blur outside the outline", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { path: "/?q=milk", anchorId: "milk" });
  const editor = row(page, "milk").locator(".node-text");
  await editor.fill("Buy mil #work");
  await expect(editor).toHaveText("Buy mil #work");
  await expect(editor).toBeFocused();
  await expect(page.locator(".outline-empty")).toHaveCount(0);

  await filterPill(page).focus();
  await expect(row(page, "milk")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "No filter matches" }),
  ).toContainText('"milk"');
});

test("a row that still matches after editing stays visible on blur", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { path: "/?q=milk", anchorId: "milk" });
  const editor = row(page, "milk").locator(".node-text");
  await placeCaret(editor, "end");
  const before = await page.evaluateHandle(async () => {
    const path = "/src/data/view-state.ts";
    const storePath = "/src/data/tree-store.ts";
    const { byId } = (await import(storePath)).getTreeIndex();
    const get = byId.get;
    let unrelatedReads = 0;
    byId.get = function (id: string) {
      if (id === "mom") unrelatedReads++;
      return get.call(this, id);
    };
    return {
      filter: (await import(path)).getViewFilter(),
      reads: () => unrelatedReads,
      restore: () => {
        byId.get = get;
      },
    };
  });
  await editor.fill("Buy more milk #work");
  // Membership did not change, so list consumers keep the same snapshot.
  // Let the editor's effects publish the post-edit view before comparing.
  expect(
    await page.evaluate(async (previous) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const path = "/src/data/view-state.ts";
      const result = {
        sameFilter: previous.filter === (await import(path)).getViewFilter(),
        unrelatedReads: previous.reads(),
      };
      return result;
    }, before),
  ).toEqual({ sameFilter: true, unrelatedReads: 0 });
  await editor.fill("Buy bread #work");
  await expect(editor).toBeFocused();
  expect(
    await page.evaluate(async (previous) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const path = "/src/data/view-state.ts";
      const filter = (await import(path)).getViewFilter();
      return {
        sameVisible: previous.filter.visibleIds === filter.visibleIds,
        retained: filter.retainedKey,
        unrelatedReads: previous.reads(),
      };
    }, before),
  ).toEqual({ sameVisible: true, retained: "milk", unrelatedReads: 0 });
  await editor.fill("Buy more milk #work");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/view-state.ts";
        return (await import(path)).getViewFilter().retainedKey;
      }),
    )
    .toBeUndefined();
  await page.evaluate((previous) => previous.restore(), before);
  await before.dispose();
  await filterPill(page).focus();
  await expect(editor).toHaveText("Buy more milk #work");
  await expect(editor).toBeVisible();
  await expect(editor).not.toBeFocused();
});

test("a retained row stays filtered out after its focused editor unmounts", async ({
  page,
}) => {
  const nodes: SeedNode[] = Array.from({ length: 200 }, (_, i) => ({
    id: `node-${i}`,
    parentId: null,
    prevSiblingId: i === 0 ? null : `node-${i - 1}`,
    text: `Match ${i}`,
  }));
  await seedOutline(page, nodes);
  await openSeededOutline(page, { path: "/?q=match", anchorId: "node-0" });
  const editor = row(page, "node-0").locator(".node-text");
  await editor.fill("Edited");
  await placeCaret(editor, "end");
  await editor.press("!");
  await expect(editor).toHaveText("Edited!");
  await expect(editor).toBeFocused();

  await page.locator(".outline-scroll").evaluate((el) => el.scrollTo(0, 4000));
  await expect(row(page, "node-0")).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator("li[data-node-id]")
        .first()
        .getAttribute("data-index")
        .then(Number),
    )
    .toBeGreaterThan(50);
  await page.locator(".outline-scroll").evaluate((el) => el.scrollTo(0, 0));
  await expect(row(page, "node-1")).toBeVisible();
  await expect(row(page, "node-0")).toHaveCount(0);
  await expect(filterPill(page)).toContainText("match");
});

test("a focus-only retained parent has no ineffective expand control", async ({
  page,
}) => {
  await seedOutline(page, [
    {
      id: "parent",
      parentId: null,
      prevSiblingId: null,
      text: "Project #work",
    },
    {
      id: "child",
      parentId: "parent",
      prevSiblingId: null,
      text: "Unrelated child",
    },
  ]);
  await openSeededOutline(page, { path: "/?q=%23work", anchorId: "parent" });
  await expect(row(page, "child")).toBeVisible();
  const editor = row(page, "parent").locator(".node-text");
  await editor.fill("Project");
  await expect(editor).toBeFocused();
  await expect(row(page, "child")).toHaveCount(0);
  await expect(row(page, "parent").locator(".collapse-toggle")).toHaveAttribute(
    "data-has-children",
    "false",
  );
  await expect(row(page, "parent").locator(".collapse-toggle svg")).toHaveCount(
    0,
  );
  await expect(row(page, "parent").locator(".outline-row")).toHaveAttribute(
    "data-context",
    "false",
  );

  await editor.fill("Project #work");
  await expect(row(page, "child")).toBeVisible();
  await expect(row(page, "parent").locator(".collapse-toggle")).toHaveAttribute(
    "data-has-children",
    "true",
  );
});

test("the pill stays while you edit, and Cmd+F edits the applied query", async ({
  page,
}) => {
  await load(page);
  await applyFilter(page, "#work");

  // Working in the outline keeps the filter and its pill.
  await row(page, "milk").first().locator(".node-text").first().click();
  await expect(filterPill(page)).toHaveText("#workin Home");
  await expect(page).toHaveURL(/q=%23work/);

  // Cmd+F reopens Find with the applied query, ready to change it.
  await page.keyboard.press("ControlOrMeta+f");
  await expect(findInput(page)).toHaveValue("#work");
  await findInput(page).fill("#work is:todo");
  await findInput(page).press("Shift+Enter");
  await expect(filterPill(page)).toHaveText("#work is:todoin Home");
  await expect(row(page, "milk").first()).toBeVisible();
  await expect(row(page, "ship")).toHaveCount(0);

  // An emptied query clears the filter instead of leaving an empty pill.
  await page.keyboard.press("ControlOrMeta+f");
  await findInput(page).fill("");
  await findInput(page).press("Shift+Enter");
  await expect(page).not.toHaveURL(/q=/);
  await expect(filterPill(page)).toHaveCount(0);
});

test("window Escape clears an active filter in one press", async ({ page }) => {
  await load(page);
  await applyFilter(page, "#work");
  // Show in outline leaves focus on the pill, outside the outline.
  await expect(filterPill(page)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/q=/);
  await expect(filterPill(page)).toHaveCount(0);
});

const tree: SeedNode[] = [
  {
    id: "project",
    parentId: null,
    prevSiblingId: null,
    text: "Project #dotflowy",
    collapsed: true,
  },
  {
    id: "source",
    parentId: "project",
    prevSiblingId: null,
    text: "Ship search #dotflowy",
    isTask: true,
  },
  {
    id: "child",
    parentId: "source",
    prevSiblingId: null,
    text: "Verify mirror traversal #child",
  },
  {
    id: "done",
    parentId: "project",
    prevSiblingId: "source",
    text: "Completed task #dotflowy",
    isTask: true,
    completed: true,
  },
  {
    id: "untagged",
    parentId: "project",
    prevSiblingId: "done",
    text: "Untagged task",
    isTask: true,
  },
  {
    id: "scope",
    parentId: null,
    prevSiblingId: "project",
    text: "Today",
    collapsed: true,
  },
  {
    id: "mirror",
    parentId: "scope",
    prevSiblingId: null,
    text: "stale mirror fields",
    mirrorOf: "source",
    completed: true,
  },
];

test("editing a mirrored descendant keeps only the focused path and its context until blur", async ({
  page,
}) => {
  await seedOutline(page, tree);
  await openSeededOutline(page, { path: "/?q=%23child", anchorId: "project" });
  await expect(row(page, "child")).toHaveCount(2);
  const editor = row(page, "child").last().locator(".node-text");
  await editor.fill("Verify mirror traversal");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("Verify mirror traversal");
  await expect(row(page, "child")).toHaveCount(1);
  await expect(row(page, "project")).toHaveCount(0);
  await expect(row(page, "scope")).toBeVisible();
  await expect(row(page, "mirror")).toBeVisible();
  await expect(row(page, "scope").locator(".outline-row")).toHaveAttribute(
    "data-context",
    "true",
  );

  await filterPill(page).focus();
  await expect(row(page, "child")).toHaveCount(0);
  await expect(row(page, "scope")).toHaveCount(0);
  await expect(row(page, "mirror")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "No filter matches" }),
  ).toContainText('"#child"');
});

test("recovery counts stay local through mirrors and respect the completed setting", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("dotflowy:show-completed", "false"),
  );
  await seedOutline(page, tree);
  await openSeededOutline(page, { path: "/scope", anchorId: "mirror" });
  await applyFilter(page, "#child missing");
  const empty = page.getByRole("region", { name: "No filter matches" });
  await expect(empty.getByRole("heading")).toContainText("Today");
  // Only the mirrored path is in scope, not its source path under Project.
  await expect(empty.getByRole("button", { name: /^Remove / })).toHaveText([
    'Remove "missing"1',
  ]);
  await empty.getByRole("button", { name: /^Remove / }).click();
  await expect(row(page, "child")).toHaveCount(1);
  await expect(row(page, "project")).toHaveCount(0);

  await openSeededOutline(page, { path: "/project", anchorId: "source" });
  await applyFilter(page, "is:complete");
  const showCompleted = empty.getByRole("button", { name: /^Show completed/ });
  await expect(showCompleted).toHaveText("Show completed1");
  await expect(empty.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await showCompleted.click();
  await expect(filterPill(page)).toContainText("is:complete");
  await expect(row(page, "done")).toBeVisible();
  await expect(empty).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("dotflowy:show-completed")),
  ).toBe("true");

  await applyFilter(page, "missing");
  await expect(empty).toBeVisible();
  await expect(showCompleted).toHaveCount(0);
});

test("the same query selects source and mirror content, while is:mirror excludes the source", async ({
  page,
}) => {
  await seedOutline(page, tree);
  await openSeededOutline(page, { anchorId: "project" });
  await applyFilter(page, "is:todo -is:complete #dotflowy");
  await expect(row(page, "source")).toBeVisible();
  await expect(row(page, "mirror")).toBeVisible();
  await expect(row(page, "mirror").locator(".node-text")).toContainText(
    "Ship search",
  );
  await expect(row(page, "done")).toHaveCount(0);
  await expect(row(page, "untagged")).toHaveCount(0);

  await applyFilter(page, "is:todo -is:complete #dotflowy is:mirror");
  await expect(row(page, "source")).toHaveCount(0);
  await expect(row(page, "project")).toHaveCount(0);
  await expect(row(page, "mirror")).toBeVisible();
  await expect(row(page, "child")).toHaveCount(1);
  await expect(row(page, "mirror").locator(".outline-row")).toHaveAttribute(
    "data-context",
    "false",
  );
  await expect(row(page, "scope").locator(".outline-row")).toHaveAttribute(
    "data-context",
    "true",
  );
});

test("a zoomed view finds descendants through a mirror with contextual ancestors", async ({
  page,
}) => {
  await seedOutline(page, tree);
  await openSeededOutline(page, {
    path: "/scope?q=%23child",
    anchorId: "mirror",
  });
  await expect(filterPill(page)).toContainText("#child");
  await expect(row(page, "mirror")).toBeVisible();
  await expect(row(page, "mirror").locator(".outline-row")).toHaveAttribute(
    "data-context",
    "true",
  );
  await expect(row(page, "child")).toHaveCount(1);
  await expect(row(page, "child").locator(".outline-row")).toHaveAttribute(
    "data-context",
    "false",
  );
  await expect(row(page, "source")).toHaveCount(0);
  await expect(row(page, "project")).toHaveCount(0);
});

test("collapse affects only the selected source or mirror path under a filter", async ({
  page,
}) => {
  await seedOutline(page, [
    {
      id: "source",
      parentId: null,
      prevSiblingId: null,
      text: "Project #project",
      collapsed: true,
    },
    {
      id: "child",
      parentId: "source",
      prevSiblingId: null,
      text: "Nonmatching child",
    },
    {
      id: "mirror",
      parentId: null,
      prevSiblingId: "source",
      text: "",
      mirrorOf: "source",
    },
  ]);
  await openSeededOutline(page, { path: "/?q=%23project", anchorId: "source" });
  const child = row(page, "child");
  await expect(row(page, "source")).toBeVisible();
  await expect(row(page, "mirror")).toBeVisible();
  await expect(child).toHaveCount(1);
  await expect(child).toHaveAttribute("data-index", "2");
  await expect(child).toHaveAttribute("data-depth", "1");
  await expect(child.locator(".outline-row")).toHaveAttribute(
    "data-context",
    "false",
  );
  await expect(
    row(page, "source").getByRole("button", { name: "Expand", exact: true }),
  ).toHaveAttribute("data-has-children", "true");
  await expect(
    row(page, "mirror").getByRole("button", {
      name: "Collapse",
      exact: true,
    }),
  ).toBeVisible();

  await row(page, "source")
    .getByRole("button", { name: "Expand", exact: true })
    .click();
  await expect(child).toHaveCount(2);
  await row(page, "mirror")
    .getByRole("button", { name: "Collapse", exact: true })
    .click();
  await expect(child).toHaveCount(1);
  await expect(child).toHaveAttribute("data-index", "1");
  await expect(
    row(page, "mirror").getByRole("button", { name: "Expand", exact: true }),
  ).toHaveAttribute("data-has-children", "true");
  await expect(
    row(page, "source").getByRole("button", {
      name: "Collapse",
      exact: true,
    }),
  ).toBeVisible();

  await row(page, "source")
    .getByRole("button", { name: "Collapse", exact: true })
    .click();
  await expect(child).toHaveCount(0);
  await row(page, "mirror")
    .getByRole("button", { name: "Expand", exact: true })
    .click();
  await expect(child).toHaveCount(1);
});
