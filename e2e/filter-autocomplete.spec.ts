import { expect, test, type Page } from "@playwright/test";

import {
  findInput,
  openSeededOutline,
  seedOutline,
  type SeedNode,
} from "./fixtures";

// Registry-driven query autocomplete in Find, the one search box (ADR 0047 §7,
// ADR 0089): a `key:` token shows that key's registered values and `#` shows
// the tag corpus. Selection only inserts text into Find's input; Shift+Enter
// applies the query to the outline. A bare word suggests nothing, so nodes and
// commands stay on top.

const TREE: SeedNode[] = [
  {
    id: "milk",
    parentId: null,
    prevSiblingId: null,
    text: "Buy milk #work",
    isTask: true,
  },
  { id: "mom", parentId: null, prevSiblingId: "milk", text: "Call mom" },
  { id: "ship", parentId: null, prevSiblingId: "mom", text: "Ship it #work" },
  { id: "home", parentId: null, prevSiblingId: "ship", text: "Tidy #home" },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);
const suggestions = (page: Page) =>
  page.getByRole("dialog", { name: "Find" }).getByRole("group", {
    name: "Suggestions",
  });
const option = (page: Page, name: string | RegExp) =>
  suggestions(page).getByRole("option", { name, exact: true });

async function load(page: Page) {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "milk" });
}

async function summon(page: Page) {
  await page.keyboard.press("ControlOrMeta+f");
  await expect(findInput(page)).toBeFocused();
}

test("browser autocomplete and Worker search register the same operator metadata", async ({
  page,
}) => {
  await load(page);
  const metadata = await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts";
    const workerPath = "/src/plugins/filter-operators.ts";
    const queryPath = "/src/data/filter-query.ts";
    const { filterOperatorInfos } = await import(registryPath);
    const { queryOperators } = await import(workerPath);
    const { collectOperatorKeyInfos } = await import(queryPath);
    return {
      browser: filterOperatorInfos,
      worker: collectOperatorKeyInfos([...new Set(queryOperators.values())]),
    };
  });
  expect(metadata.browser).toEqual(metadata.worker);
  expect(metadata.browser.map((info: { key: string }) => info.key)).toEqual([
    "is",
    "has",
    "highlight",
  ]);
  await summon(page);
  await findInput(page).fill("highlight:");
  await expect(option(page, "highlight:red")).toBeVisible();
  await expect(option(page, "highlight:blue")).toBeVisible();
});

test("typing `is:` lists its values incl. todo; click inserts, Shift+Enter filters", async ({
  page,
}) => {
  await load(page);
  await summon(page);

  await findInput(page).fill("is:");
  // Values folded from every plugin sharing the `is` key (core + todos + …).
  await expect(option(page, "is:todo")).toBeVisible();
  await expect(option(page, "is:complete")).toBeVisible();
  await expect(page.getByText("No matches.")).toHaveCount(0);

  await option(page, "is:todo").click();

  // Insertion writes the completed term (trailing space) into Find's input and
  // keeps focus there; the outline is untouched until Shift+Enter.
  await expect(findInput(page)).toHaveValue("is:todo ");
  await expect(findInput(page)).toBeFocused();
  await expect(page).not.toHaveURL(/q=/);
  await findInput(page).press("Shift+Enter");
  await expect(page).toHaveURL(/[?&]q=is%3Atodo/);
  await expect(row(page, "milk").first()).toBeVisible();
  await expect(row(page, "mom")).toHaveCount(0);
  await expect(row(page, "ship")).toHaveCount(0);
});

test("keyboard: the first suggestion is active and Enter inserts it", async ({
  page,
}) => {
  await load(page);
  await summon(page);

  await findInput(page).fill("is:c");
  await expect(option(page, "is:complete")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await findInput(page).press("Enter");
  await expect(findInput(page)).toHaveValue("is:complete ");
  await expect(findInput(page)).toBeVisible();
});

test("a bare word suggests nothing; an unknown key suggests nothing", async ({
  page,
}) => {
  await load(page);
  await summon(page);
  await findInput(page).fill("is");
  await expect(suggestions(page)).toHaveCount(0);
  await findInput(page).fill("https:");
  await expect(suggestions(page)).toHaveCount(0);
});

test("`#` shows seeded tags; picking one then Shift+Enter filters", async ({
  page,
}) => {
  await load(page);
  await summon(page);

  await findInput(page).fill("#");
  await expect(option(page, "#home")).toBeVisible();
  await expect(option(page, "#work")).toBeVisible();

  await option(page, "#work").click();

  await expect(findInput(page)).toHaveValue("#work ");
  await findInput(page).press("Shift+Enter");
  await expect(page).toHaveURL(/q=%23work/);
  await expect(row(page, "milk").first()).toBeVisible();
  await expect(row(page, "ship").first()).toBeVisible();
  await expect(row(page, "mom")).toHaveCount(0);
  await expect(row(page, "home")).toHaveCount(0);
});
