import { expect, test, type Page } from "@playwright/test";

import { openSeededOutline, seedOutline, type SeedNode } from "./fixtures";

// The `?q=` filter input (ADR 0047 §6, amended 2026-07-11): CORE subheader
// chrome opened by Cmd+F / the header magnifier / the Cmd+K "Filter this view"
// action. Live (debounced) filtering while composing; the raw query stays
// RESIDENT in the input while `?q=` is active -- focused or not (the pill state
// is dead). A trailing clear X, and a progressive Escape ladder (close the
// popover -> clear the text -> collapse the row).

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

const input = (page: Page) => page.locator('[aria-label="Filter query"]');

async function load(page: Page) {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "milk" });
}

async function summon(page: Page) {
  await page.keyboard.press("ControlOrMeta+f");
  await expect(input(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
}

test.describe("resident filter input (ADR 0047 §6)", () => {
  test("Cmd+F opens the filter input, focused", async ({ page }) => {
    await load(page);
    await summon(page);
  });

  test("the header magnifier opens the filter input", async ({ page }) => {
    await load(page);
    await page.getByRole("button", { name: "Filter this view" }).click();
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
  });

  test("the header magnifier toggles the filter closed", async ({ page }) => {
    await load(page);
    const magnifier = page.getByRole("button", { name: "Filter this view" });

    await magnifier.click();
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeFocused();

    // Empty summon: second press collapses the row.
    await magnifier.click();
    await expect(input(page)).toHaveCount(0);

    // With an active query: second press clears `?q=` AND collapses.
    await magnifier.click();
    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);
    await magnifier.click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(input(page)).toHaveCount(0);
  });

  test("the magnifier's three states track the stakes (ADR 0050)", async ({
    page,
  }) => {
    await load(page);
    const magnifier = page.getByRole("button", { name: "Filter this view" });
    // Match the STANDALONE fill token, not the ghost variant's `hover:bg-muted`
    // / `aria-expanded:bg-muted` utilities (a bare `/bg-muted/` would).
    const muted = /(?:^|\s)bg-muted(?:\s|$)/;
    const solid = /(?:^|\s)bg-primary(?:\s|$)/;

    // Idle: ghost, not pressed -- neither the muted nor the solid fill.
    await expect(magnifier).toHaveAttribute("aria-pressed", "false");
    await expect(magnifier).not.toHaveClass(muted);
    await expect(magnifier).not.toHaveClass(solid);

    // Open but empty: pressed + MUTED ("a tool is engaged, view still normal").
    // This is the state the button previously lacked -- opening it now reads.
    await magnifier.click();
    await expect(input(page)).toBeVisible();
    await expect(magnifier).toHaveAttribute("aria-pressed", "true");
    await expect(magnifier).toHaveClass(muted);

    // Query applied: still pressed, now SOLID ("your view is altered") -- so the
    // toggle-off press that WIPES the query only fires while it reads as "on".
    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);
    await expect(magnifier).toHaveAttribute("aria-pressed", "true");
    await expect(magnifier).toHaveClass(solid);
    await expect(magnifier).not.toHaveClass(muted);

    // Toggle-off clears the query, collapses the row, and drops the lit state.
    await magnifier.click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(magnifier).toHaveAttribute("aria-pressed", "false");
    await expect(magnifier).not.toHaveClass(muted);
    await expect(magnifier).not.toHaveClass(solid);
  });

  test("the ⌘ button opens the command center", async ({ page }) => {
    await load(page);
    await page.getByRole("button", { name: "Command center" }).click();
    await expect(
      page.getByPlaceholder(/Search nodes and actions/),
    ).toBeVisible();
    // And it is NOT the filter input.
    await expect(input(page)).toHaveCount(0);
  });

  test("the Cmd+K action opens the filter input", async ({ page }) => {
    await load(page);

    await page.keyboard.press("ControlOrMeta+k");
    await expect(
      page.getByPlaceholder(/Search nodes and actions/),
    ).toBeVisible();

    await page.getByRole("option", { name: /Filter this view/ }).click();

    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
  });

  test("typing filters the view live", async ({ page }) => {
    await load(page);
    await summon(page);

    // `is:todo` (a core operator) keeps the task, prunes the plain bullets.
    await input(page).fill("is:todo");

    await expect(row(page, "milk").first()).toBeVisible();
    await expect(row(page, "mom")).toHaveCount(0);
    await expect(row(page, "ship")).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]q=is/);
  });

  test("a free-text term filters by substring", async ({ page }) => {
    await load(page);
    await summon(page);

    await input(page).fill("milk");

    await expect(row(page, "milk").first()).toBeVisible();
    await expect(row(page, "mom")).toHaveCount(0);
    await expect(row(page, "ship")).toHaveCount(0);
  });

  for (const query of ["#work", "work"]) {
    test(`editing out ${query} keeps focus until moving to another row`, async ({
      page,
    }) => {
      await seedOutline(page, TREE);
      await page.goto(`/?q=${encodeURIComponent(query)}`);
      const editor = row(page, "milk").locator(".node-text");
      await expect(editor).toBeVisible();
      await editor.focus();
      await editor.press("End");
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
      await expect(input(page)).toHaveValue(query);
    });
  }

  test("editing the last match keeps the row until blur outside the outline", async ({
    page,
  }, testInfo) => {
    await seedOutline(page, TREE);
    await page.goto("/?q=milk");
    const editor = row(page, "milk").locator(".node-text");
    await expect(editor).toBeVisible();
    await editor.fill("Buy mil #work");
    await expect(editor).toHaveText("Buy mil #work");
    await expect(editor).toBeFocused();
    await expect(page.locator(".outline-empty")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("focused-nonmatch.png"),
    });

    await input(page).focus();
    await expect(row(page, "milk")).toHaveCount(0);
    await expect(page.locator(".outline-empty")).toHaveText(
      'No matches for "milk" here.',
    );
    await page.screenshot({
      path: testInfo.outputPath("blurred-nonmatch.png"),
    });
  });

  test("a row that still matches after editing stays visible on blur", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await page.goto("/?q=milk");
    const editor = row(page, "milk").locator(".node-text");
    await expect(editor).toBeVisible();
    await editor.fill("Buy more milk #work");
    await input(page).focus();
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
    await editor.press("End");
    await editor.press("!");
    await expect(editor).toHaveText("Edited!");
    await expect(editor).toBeFocused();

    await page.evaluate(() => window.scrollTo(0, 4000));
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
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(row(page, "node-1")).toBeVisible();
    await expect(row(page, "node-0")).toHaveCount(0);
    await expect(input(page)).toHaveValue("match");
  });

  test("a focus-only retained parent has no ineffective expand control", async ({
    page,
  }, testInfo) => {
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
    await expect(
      row(page, "parent").locator(".collapse-toggle"),
    ).toHaveAttribute("data-has-children", "false");
    await expect(
      row(page, "parent").locator(".collapse-toggle svg"),
    ).toHaveCount(0);
    await expect(row(page, "parent").locator(".outline-row")).toHaveAttribute(
      "data-context",
      "false",
    );
    await page.screenshot({ path: testInfo.outputPath("retained-parent.png") });

    await editor.fill("Project #work");
    await expect(row(page, "child")).toBeVisible();
    await expect(
      row(page, "parent").locator(".collapse-toggle"),
    ).toHaveAttribute("data-has-children", "true");
  });

  test("Enter commits, blurs, and the input stays resident", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await input(page).press("Enter");

    // No pills: the input stays resident showing the raw query, but blurred.
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue("#work");
    await expect(input(page)).not.toBeFocused();
    await expect(page).toHaveURL(/q=%23work/);
  });

  test("the input stays resident on blur while a query is active", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);

    // Close the autocomplete popover (so it can't intercept the click), then
    // blur into the outline by focusing a matching bullet. The row stays open.
    await input(page).press("Escape");
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    await row(page, "milk").first().locator(".node-text").first().click();
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue("#work");
    await expect(input(page)).not.toBeFocused();
    await expect(page).toHaveURL(/q=%23work/);
  });

  test("empty text + blur collapses the row", async ({ page }) => {
    await load(page);
    await summon(page);
    await expect(input(page)).toBeVisible();

    // Close the empty-focus cheat-sheet popover, then blur with no text and no
    // active filter -> the subheader collapses away.
    await input(page).press("Escape");
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    await row(page, "mom").locator(".node-text").first().click();
    await expect(input(page)).toHaveCount(0);
  });

  test("the clear X wipes the text and the query, keeping focus", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);

    await page.getByRole("button", { name: "Clear filter" }).click();

    await expect(input(page)).toHaveValue("");
    await expect(input(page)).toBeFocused();
    await expect(page).not.toHaveURL(/q=/);
    // Cleared but still summoned -> the input stays open.
    await expect(input(page)).toBeVisible();
  });

  test("Escape ladder: close the popover, clear the text, collapse the row", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await expect(page).toHaveURL(/q=%23work/);
    // `#work` opens the tag-suggestion popover (ADR 0047 §7 autocomplete).
    const listbox = page.locator('[role="listbox"]');
    await expect(listbox).toBeVisible();

    // Stage 1: Escape closes ONLY the popover; the input stays open + focused,
    // the query intact.
    await input(page).press("Escape");
    await expect(listbox).toHaveCount(0);
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(page).toHaveURL(/q=%23work/);

    // Stage 2: Escape clears the text AND the query, keeping focus.
    await input(page).press("Escape");
    await expect(input(page)).toHaveValue("");
    await expect(input(page)).toBeFocused();
    await expect(page).not.toHaveURL(/q=/);

    // Stage 3: a final Escape (empty, no popover) collapses the row.
    await input(page).press("Escape");
    await expect(input(page)).toHaveCount(0);
  });

  test("window Escape clears an active filter in one press", async ({
    page,
  }) => {
    await load(page);
    await summon(page);

    await input(page).fill("#work");
    await input(page).press("Enter"); // commit + blur; input stays resident
    await expect(input(page)).not.toBeFocused();
    await expect(page).toHaveURL(/q=%23work/);

    // The caret is not in the outline and no input is focused: one window-level
    // Escape clears the whole filter and collapses the row.
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/q=/);
    await expect(input(page)).toHaveCount(0);
  });
});

test.describe("DQL mirror parity", () => {
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
    await page.goto("/?q=%23child");
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

    await input(page).focus();
    await expect(row(page, "child")).toHaveCount(0);
    await expect(row(page, "scope")).toHaveCount(0);
    await expect(row(page, "mirror")).toHaveCount(0);
    await expect(page.locator(".outline-empty")).toHaveText(
      'No matches for "#child" here.',
    );
  });

  test("the same query selects source and mirror content, while is:mirror excludes the source", async ({
    page,
  }, testInfo) => {
    await seedOutline(page, tree);
    await page.goto("/");
    await expect(row(page, "project")).toBeVisible();
    await summon(page);
    await input(page).fill("is:todo -is:complete #dotflowy");
    await expect(row(page, "source")).toBeVisible();
    await expect(row(page, "mirror")).toBeVisible();
    await expect(row(page, "mirror").locator(".node-text")).toContainText(
      "Ship search",
    );
    await expect(row(page, "done")).toHaveCount(0);
    await expect(row(page, "untagged")).toHaveCount(0);

    await input(page).fill("is:todo -is:complete #dotflowy is:mirror");
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
    await input(page).press("Enter");
    await page.screenshot({
      path: testInfo.outputPath("dql-mirror-filter.png"),
    });
  });

  test("a zoomed view finds descendants through a mirror with contextual ancestors", async ({
    page,
  }) => {
    await seedOutline(page, tree);
    await page.goto("/scope?q=%23child");
    await expect(input(page)).toHaveValue("#child");
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
  }, testInfo) => {
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
    await page.goto("/?q=%23project");
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
    await page.screenshot({
      path: testInfo.outputPath("dql-local-collapse.png"),
    });

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
});
