import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  type SeedNode,
} from "./fixtures";

// Node links + backlinks (ADR 0032): a `[[nodeId]]` token renders as a chip
// showing the TARGET's live text (Seam A widget), click zooms to the target
// (Seam B), `[[` opens the picker (Seam H), and the zoomed view shows a quiet
// "{n} backlinks" line opening the jump list (core chrome).

const TARGET = "11111111-2222-3333-4444-555555555555";
const REF = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const TREE: SeedNode[] = [
  { id: TARGET, parentId: null, prevSiblingId: null, text: "Project Phoenix" },
  {
    id: REF,
    parentId: null,
    prevSiblingId: TARGET,
    text: `kickoff for [[${TARGET}]]`,
  },
  { id: "blank", parentId: null, prevSiblingId: REF, text: "" },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

const chipIn = (page: Page, id: string) =>
  text(page, id).locator(`[data-node-link="${TARGET}"]`);

async function load(page: Page) {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: TARGET });
}

/** Focus a bullet and place the caret at the end of its text via the Selection
 *  API (a plain click can land on a chip or past the text -- see CONTRIBUTING.md). */
async function caretAtEnd(page: Page, id: string) {
  await placeCaret(text(page, id), "end");
}

test("a copied node URL pastes as a live link, follows a rename, and returns through backlinks", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedOutline(
    page,
    TREE.map((node) =>
      node.id === REF ? { ...node, text: "kickoff for " } : node,
    ),
  );
  await openSeededOutline(page, { anchorId: TARGET });
  await text(page, TARGET).click();
  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await page
    .getByRole("menuitem", { name: "Copy link to node", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(new URL(`/${TARGET}`, page.url()).href);
  await caretAtEnd(page, REF);
  await page.keyboard.press("ControlOrMeta+v");

  const chip = chipIn(page, REF);
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Project Phoenix");
  await expect(page.getByRole("menu", { name: "Paste as" })).toHaveCount(0);

  // Rename the target: every chip updates -- the label is the target's text
  // read live, not a snapshot (the id-in-source model, ADR 0032).
  await caretAtEnd(page, TARGET);
  await page.keyboard.type(" v2");
  await expect(chip).toContainText("Project Phoenix v2");

  await chip.click();
  await expect(page).toHaveURL(new RegExp(TARGET));
  await expect(page.locator(".zoomed-title")).toContainText(
    "Project Phoenix v2",
  );

  // Re-enter the target directly so backlink hydration is covered too.
  await page.reload();
  await page.locator(".zoomed-title").waitFor({ state: "visible" });
  await expect(page.locator(".zoomed-title")).toContainText(
    "Project Phoenix v2",
  );

  // Backlinks use the live label too, and count referring nodes rather than links.
  const line = page.getByRole("button", { name: /1 backlink/ });
  await expect(line).toBeVisible();
  await line.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("kickoff for Project Phoenix v2");
  await dialog.getByText("kickoff for").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(text(page, REF)).toBeVisible();

  // REF has a link IN its text but nothing links TO it.
  await page.goto(`/${REF}`);
  await page.locator(".zoomed-title").waitFor({ state: "visible" });
  await expect(page.getByRole("button", { name: /backlink/ })).toHaveCount(0);
});

test("an empty node offers link or mirror, preserves its position, and supports undo", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedOutline(page, [
    ...TREE,
    {
      id: "child",
      parentId: TARGET,
      prevSiblingId: null,
      text: "Release notes",
    },
    { id: "after", parentId: null, prevSiblingId: "blank", text: "Keep after" },
  ]);
  await openSeededOutline(page, { anchorId: TARGET });
  const editor = text(page, "blank");
  const menu = page.getByRole("menu", { name: "Paste as" });
  const row = page.locator('li[data-node-id="blank"]');
  const url = new URL(`/${TARGET}`, page.url()).href;
  await page.evaluate((value) => navigator.clipboard.writeText(value), url);

  // Every dismissal keeps the already-saved inline link, without mirroring.
  for (const choice of ["Escape", "Link to node", "outside"]) {
    await editor.fill("");
    await page.keyboard.press("ControlOrMeta+v");
    await expect(
      menu.getByRole("menuitem", { name: "Mirror node" }),
    ).toBeEnabled();
    await expect(
      menu.getByRole("menuitem", { name: "Link to node" }),
    ).toBeFocused();
    if (choice === "Escape") await page.keyboard.press("Escape");
    else if (choice === "outside") await text(page, "after").click();
    else await menu.getByRole("menuitem", { name: choice }).click();
    await expect(menu).toHaveCount(0);
    await expect(editor.locator("[data-node-link]")).toContainText(
      "Project Phoenix",
    );
    await expect(row).not.toHaveAttribute("data-mirror", "instance");
    await expect(text(page, "child")).toHaveCount(1);
  }

  await editor.fill("");
  await page.keyboard.press("ControlOrMeta+v");
  await menu.getByRole("menuitem", { name: "Mirror node" }).click();
  await expect(row).toHaveAttribute("data-mirror", "instance");
  await expect(editor).toHaveText("Project Phoenix");
  await expect(editor).toBeFocused();
  await expect(text(page, "child")).toHaveCount(2);
  await expect
    .poll(() =>
      page
        .locator("li[data-node-id]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-node-id")),
        ),
    )
    .toEqual([TARGET, "child", REF, "blank", "child", "after"]);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(row).not.toHaveAttribute("data-mirror", "instance");
  await expect(editor.locator("[data-node-link]")).toContainText(
    "Project Phoenix",
  );
  await expect(text(page, "child")).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/history.ts";
        return (await import(path)).getHistoryState().canRedo;
      }),
    )
    .toBe(true);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(row).toHaveAttribute("data-mirror", "instance");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/history.ts";
        return (await import(path)).getHistoryState().busy;
      }),
    )
    .toBe(false);
  await caretAtEnd(page, "blank");
  await page.keyboard.type(" revised");
  await expect(text(page, TARGET)).toHaveText("Project Phoenix revised");
  await page.reload();
  await expect(editor).toHaveText("Project Phoenix revised");
  await expect(row).toHaveAttribute("data-mirror", "instance");
  await expect(text(page, "child")).toHaveCount(2);
});

test("paste choices disable cyclic mirrors and leave child-bearing nodes inline", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedOutline(page, [
    TREE[0]!,
    { id: REF, parentId: TARGET, prevSiblingId: null, text: "" },
    { id: "blank", parentId: null, prevSiblingId: TARGET, text: "" },
    {
      id: "child",
      parentId: "blank",
      prevSiblingId: null,
      text: "Keep this child",
    },
  ]);
  await openSeededOutline(page, { anchorId: TARGET });
  const url = new URL(`/${TARGET}`, page.url()).href;
  await page.evaluate((value) => navigator.clipboard.writeText(value), url);
  await caretAtEnd(page, REF);
  await page.keyboard.press("ControlOrMeta+v");
  const menu = page.getByRole("menu", { name: "Paste as" });
  await expect(
    menu.getByRole("menuitem", { name: "Mirror node" }),
  ).toBeDisabled();
  await expect(menu).toContainText("A mirror here would create a cycle.");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(chipIn(page, REF)).toBeVisible();

  await caretAtEnd(page, "blank");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(menu).toHaveCount(0);
  await expect(chipIn(page, "blank")).toBeVisible();
  await expect(text(page, "child")).toHaveText("Keep this child");
});

test("remote edits and in-flight children prevent mirror replacement", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const server = await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: TARGET });
  const url = new URL(`/${TARGET}`, page.url()).href;
  await page.evaluate((value) => navigator.clipboard.writeText(value), url);
  await caretAtEnd(page, "blank");
  await page.keyboard.press("ControlOrMeta+v");
  const menu = page.getByRole("menu", { name: "Paste as" });
  await expect(
    menu.getByRole("menuitem", { name: "Mirror node" }),
  ).toBeEnabled();
  const node = await page.evaluate(async () => {
    const nodes = await (await fetch("/api/nodes")).json();
    return nodes.find((node: { id: string }) => node.id === "blank");
  });
  await server.injectExternalChange([
    { op: "update", value: { ...node, text: "Notes from another device" } },
  ]);
  await expect(
    menu.getByRole("menuitem", { name: "Mirror node" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(text(page, "blank")).toHaveText("Notes from another device");
  await expect(page.locator('li[data-node-id="blank"]')).not.toHaveAttribute(
    "data-mirror",
    "instance",
  );

  await text(page, "blank").fill("");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(
    menu.getByRole("menuitem", { name: "Mirror node" }),
  ).toBeEnabled();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/nodes", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.fallback();
  });
  const sent = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/nodes" &&
      request.method() === "POST",
  );
  await menu.getByRole("menuitem", { name: "Mirror node" }).click();
  await sent;
  try {
    await server.injectExternalChange([
      {
        op: "insert",
        value: {
          ...node,
          id: "arrived",
          parentId: "blank",
          prevSiblingId: null,
          text: "Child from another device",
        },
      },
    ]);
  } finally {
    release();
  }
  await expect(
    page.getByText("Couldn't save your changes", { exact: true }),
  ).toBeVisible();
  await expect(text(page, "arrived")).toHaveText("Child from another device");
  await expect(chipIn(page, "blank")).toBeVisible();
  await expect(page.locator('li[data-node-id="blank"]')).not.toHaveAttribute(
    "data-mirror",
    "instance",
  );
});

test("an empty zoomed title can become a mirror without navigating away", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedOutline(page, [
    ...TREE,
    {
      id: "child",
      parentId: TARGET,
      prevSiblingId: null,
      text: "Shared child",
    },
  ]);
  await page.goto("/blank");
  const title = page.locator(".zoomed-title .node-text");
  await expect(title).toBeVisible();
  await placeCaret(title, "end");
  const url = new URL(`/${TARGET}`, page.url()).href;
  await page.evaluate((value) => navigator.clipboard.writeText(value), url);
  await page.keyboard.press("ControlOrMeta+v");
  await page
    .getByRole("menuitem", { name: "Mirror node", exact: true })
    .click();
  await expect(title).toHaveText("Project Phoenix");
  await expect(
    page.getByRole("button", { name: "Appears in 2 places" }),
  ).toBeVisible();
  await expect(text(page, "child")).toHaveText("Shared child");
  await expect(page).toHaveURL(/\/blank$/);
  await placeCaret(title, "end");
  await page.keyboard.type(" revised");
  await page.keyboard.press("Enter");
  await page.keyboard.type("New shared child");
  await expect(
    page.locator(".outline-list .node-text", { hasText: "New shared child" }),
  ).toBeVisible();
  await page.goto("/");
  await expect(text(page, TARGET)).toHaveText("Project Phoenix revised");
  await expect(text(page, "blank")).toHaveText("Project Phoenix revised");
  await expect(
    page.locator(".outline-list .node-text", { hasText: "New shared child" }),
  ).toHaveCount(2);
});

test("pasted URLs keep normal handling for missing or other-origin targets, and literal paste", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await load(page);
  const editor = text(page, "blank");
  const origin = new URL(page.url()).origin;
  for (const url of [
    `${origin}/99999999-2222-3333-4444-555555555555`,
    `https://other.example/${TARGET}`,
  ]) {
    await editor.fill("");
    await page.evaluate((value) => navigator.clipboard.writeText(value), url);
    await page.keyboard.press("ControlOrMeta+v");
    await expect(editor).toHaveText(url);
    await expect(editor.locator("[data-node-link]")).toHaveCount(0);
    await expect(page.getByRole("menu", { name: "Paste as" })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  const url = `${origin}/${TARGET}`;
  await editor.fill("");
  await page.evaluate((value) => navigator.clipboard.writeText(value), url);
  const cdp = await context.newCDPSession(page);
  const key = {
    modifiers: 8 | 4,
    key: "V",
    code: "KeyV",
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
  };
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...key,
    commands: ["pasteAndMatchStyle"],
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await expect(editor).toHaveText(url);
  await expect(editor.locator("[data-node-link]")).toHaveCount(0);
  await expect(page.getByRole("menu", { name: "Paste as" })).toHaveCount(0);
});

test("node URL paste works in zoomed titles and Quick-add", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedOutline(page, TREE);
  await page.goto("/blank");
  const url = new URL(`/${TARGET}`, page.url()).href;
  await page.evaluate((value) => navigator.clipboard.writeText(value), url);
  const title = page.locator(".zoomed-title .node-text");
  await expect(title).toBeVisible();
  await title.fill("Replace this title");
  await title.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(title.locator(`[data-node-link="${TARGET}"]`)).toContainText(
    "Project Phoenix",
  );
  await expect(title).not.toContainText("Replace this title");
  await title.evaluate((el: HTMLElement) => el.blur());
  await page.keyboard.press("q");
  const quickAdd = page.getByRole("textbox", {
    name: "Quick add",
    exact: true,
  });
  await expect(quickAdd).toBeFocused();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(quickAdd.locator(`[data-node-link="${TARGET}"]`)).toContainText(
    "Project Phoenix",
  );
});

test("hand-typed junk between double brackets stays literal text", async ({
  page,
}) => {
  await seedOutline(page, [
    {
      id: "a",
      parentId: null,
      prevSiblingId: null,
      text: "see [[not an id]] here",
    },
  ]);
  await openSeededOutline(page, { anchorId: "a" });

  await expect(text(page, "a")).toContainText("[[not an id]]");
  await expect(text(page, "a").locator("[data-node-link]")).toHaveCount(0);
});

test("typing [[ opens the picker; picking inserts the chip", async ({
  page,
}) => {
  await load(page);

  await text(page, "blank").click();
  await page.keyboard.type("[[Phoe");

  // The picker lists the matching node (REF's label resolves its nested link
  // to an ellipsis, so only the target itself matches "Phoe").
  const option = page
    .getByRole("listbox")
    .getByRole("option", { name: "Project Phoenix", exact: true });
  await expect(option).toBeVisible();

  await option.click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(chipIn(page, "blank")).toBeVisible();
});

test("a query with no matching node keeps the menu closed", async ({
  page,
}) => {
  await load(page);

  await text(page, "blank").click();
  await page.keyboard.type("[[zzzznope");

  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("the [[ picker opens on the zoomed page title too", async ({ page }) => {
  await load(page);
  await page.goto("/blank"); // zoom into the empty node -- it's now the title

  const title = page.locator(".zoomed-title .node-text");
  await title.waitFor({ state: "visible" });
  await title.click();
  await page.keyboard.type("[[Phoe");

  const option = page
    .getByRole("listbox")
    .getByRole("option", { name: "Project Phoenix", exact: true });
  await expect(option).toBeVisible();

  await option.click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(title.locator(`[data-node-link="${TARGET}"]`)).toBeVisible();
});
