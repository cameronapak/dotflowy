import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  seedOutline,
  text,
  type SeedNode,
} from "./fixtures";

// A flat top-level list -- the simplest shape to reason about sibling-scoped
// selection (no subtree-implied descendants to track).
const FLAT: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
  { id: "b", parentId: null, prevSiblingId: "a", text: "bravo" },
  { id: "c", parentId: null, prevSiblingId: "b", text: "charlie" },
  { id: "d", parentId: null, prevSiblingId: "c", text: "delta" },
];

// A single-child chain -- the simplest shape to reason about the depth walk at a
// sibling boundary (Shift+Up climbs to the parent, Shift+Down dives to the child)
// with no siblings around to extend into instead.
const CHAIN: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
  { id: "aa", parentId: "a", prevSiblingId: null, text: "alphaalpha" },
  { id: "aaa", parentId: "aa", prevSiblingId: null, text: "alphaalphaalpha" },
];

// A long flat list -- enough rows to overflow a short viewport, so the actions
// menu's on-screen guarantee can be tested past the fold.
const TALL: SeedNode[] = Array.from({ length: 14 }, (_, i) => ({
  id: `n${i}`,
  parentId: null,
  prevSiblingId: i === 0 ? null : `n${i - 1}`,
  text: `node${i}`,
}));

// Assert a bounding box sits fully within the viewport (1px slack for rounding).
function expectInViewport(
  box: { x: number; y: number; width: number; height: number },
  vp: { width: number; height: number },
) {
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
}

const li = (page: Page, id: string) => page.locator(`li[data-node-id="${id}"]`);

const focused = (page: Page) => page.locator(".node-text:focus");

const orderedTexts = (page: Page) =>
  page.locator(".outline-row .node-text").allTextContents();

const MOD = "ControlOrMeta";

async function load(page: Page, tree: SeedNode[] = FLAT) {
  await seedOutline(page, tree);
  await openSeededOutline(page, { anchorId: tree[0]!.id });
}

// Focus a bullet so it holds the caret (entry point for Shift+arrow / Cmd+A).
async function focus(page: Page, id: string) {
  await text(page, id).click();
  await expect(text(page, id)).toBeFocused();
}

test("filtered selection skips hidden siblings, reverses direction, and deletes only the visible run", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "alpha #go" },
    { id: "b", parentId: null, prevSiblingId: "a", text: "hidden bravo" },
    { id: "c", parentId: null, prevSiblingId: "b", text: "charlie #go" },
    { id: "d", parentId: null, prevSiblingId: "c", text: "delta #go" },
  ]);
  await openSeededOutline(page, { path: "/?q=%23go", anchorId: "a" });
  await expect(li(page, "b")).toHaveCount(0);
  await focus(page, "a");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "c")).toHaveAttribute("data-selected", "bottom");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "a")).toHaveAttribute("data-selected", "single");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Delete");
  await expect.poll(() => orderedTexts(page)).toEqual(["delta #go"]);
  await page.keyboard.press(`${MOD}+z`);
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["alpha #go", "charlie #go", "delta #go"]);
  await page.goto("/");
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["alpha #go", "hidden bravo", "charlie #go", "delta #go"]);
});

test("filtered select-all deletes only visible roots and preserves their hidden siblings", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "alpha #go" },
    { id: "b", parentId: null, prevSiblingId: "a", text: "hidden bravo" },
    { id: "c", parentId: null, prevSiblingId: "b", text: "charlie #go" },
  ]);
  await openSeededOutline(page, { path: "/?q=%23go", anchorId: "a" });
  await focus(page, "a");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press("Delete");
  await expect(page.locator(".outline-row .node-text")).toHaveCount(0);
  await page.goto("/");
  await expect.poll(() => orderedTexts(page)).toEqual(["hidden bravo"]);
});

test("filtered depth selection reaches matches inside collapsed context without changing collapse", async ({
  page,
}) => {
  await seedOutline(page, [
    {
      id: "p",
      parentId: null,
      prevSiblingId: null,
      text: "context",
      collapsed: true,
    },
    { id: "a", parentId: "p", prevSiblingId: null, text: "hidden first" },
    { id: "b", parentId: "p", prevSiblingId: "a", text: "match #go" },
    { id: "c", parentId: "b", prevSiblingId: null, text: "revealed child" },
  ]);
  await openSeededOutline(page, { path: "/?q=%23go", anchorId: "p" });
  await focus(page, "p");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "p")).not.toHaveAttribute("data-selected", /.*/);
  await expect(li(page, "b")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "c")).toHaveAttribute("data-selected", "bottom");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "c")).toHaveAttribute("data-selected", "single");
  await page.keyboard.press("Escape");
  await expect(text(page, "c")).toBeFocused();
  await page.goto("/");
  await expect.poll(() => orderedTexts(page)).toEqual(["context"]);
});

test("filtered mirror selection uses its own render path for visibility, caret exits, and undo", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "p", parentId: null, prevSiblingId: null, text: "source" },
    { id: "m", parentId: null, prevSiblingId: "p", text: "", mirrorOf: "p" },
    { id: "a", parentId: "p", prevSiblingId: null, text: "alpha #go" },
    {
      id: "b",
      parentId: "p",
      prevSiblingId: "a",
      text: "revealed only under mirror",
    },
    { id: "c", parentId: "p", prevSiblingId: "b", text: "charlie #go" },
    { id: "cc", parentId: "c", prevSiblingId: null, text: "revealed child" },
  ]);
  await openSeededOutline(page, {
    path: "/?q=is%3Amirror%20OR%20%23go",
    anchorId: "p",
  });
  await expect(text(page, "a")).toHaveCount(2);
  await expect(text(page, "b")).toHaveCount(1);
  await text(page, "a").nth(0).click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "c").nth(0)).toHaveAttribute("data-selected", "middle");
  await expect(li(page, "cc").nth(0)).toHaveAttribute(
    "data-selected",
    "bottom",
  );
  await expect(li(page, "a").nth(1)).not.toHaveAttribute("data-selected", /.*/);
  await expect(li(page, "b")).not.toHaveAttribute("data-selected", /.*/);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /^Move/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(text(page, "c").nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(text(page, "cc").nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(text(page, "m")).toBeFocused();

  await text(page, "c").nth(1).click();
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "b")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "cc").nth(1)).toHaveAttribute(
    "data-selected",
    "bottom",
  );
  await page.keyboard.press("Delete");
  await expect(text(page, "c")).toHaveCount(0);
  await expect(text(page, "cc")).toHaveCount(0);
  await expect(text(page, "a").nth(1)).toBeFocused();
  await page.keyboard.press(`${MOD}+z`);
  await expect(li(page, "b")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "cc").nth(1)).toHaveAttribute(
    "data-selected",
    "bottom",
  );
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "c").nth(1)).toHaveAttribute("data-selected", "top");
  await expect(li(page, "cc").nth(1)).toHaveAttribute(
    "data-selected",
    "bottom",
  );
  await page.keyboard.press("Escape");
  await expect(text(page, "c").nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(text(page, "cc").nth(1)).toBeFocused();
});

test("filtered indent moves only selected siblings and keeps reverse selection through undo", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "p", parentId: null, prevSiblingId: null, text: "context" },
    { id: "t", parentId: "p", prevSiblingId: null, text: "target #go" },
    { id: "a", parentId: "p", prevSiblingId: "t", text: "alpha #go" },
    { id: "b", parentId: "p", prevSiblingId: "a", text: "hidden bravo" },
    { id: "c", parentId: "p", prevSiblingId: "b", text: "charlie #go" },
  ]);
  await openSeededOutline(page, { path: "/?q=%23go", anchorId: "p" });
  await focus(page, "c");
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
  await page.keyboard.press("Tab");
  await expect(li(page, "a")).toHaveAttribute("data-parent-id", "t");
  await expect(li(page, "c")).toHaveAttribute("data-parent-id", "t");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const nodes = await (await fetch("/api/nodes")).json();
        return nodes.find((node: SeedNode) => node.id === "b")?.parentId;
      }),
    )
    .toBe("p");
  await page.keyboard.press(`${MOD}+z`);
  await expect(li(page, "a")).toHaveAttribute("data-parent-id", "p");
  await expect(li(page, "c")).toHaveAttribute("data-selected", "bottom");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "c")).toHaveAttribute("data-selected", "single");
  await page.goto("/");
  await expect
    .poll(() => orderedTexts(page))
    .toEqual([
      "context",
      "target #go",
      "alpha #go",
      "hidden bravo",
      "charlie #go",
    ]);
  await expect(li(page, "b")).toHaveAttribute("data-parent-id", "p");
});

test("filtered indent and outdent retain selection under a collapsed mirror", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "p", parentId: null, prevSiblingId: null, text: "source" },
    {
      id: "m",
      parentId: null,
      prevSiblingId: "p",
      text: "",
      mirrorOf: "p",
      collapsed: true,
    },
    { id: "a", parentId: "p", prevSiblingId: null, text: "target #go" },
    { id: "b", parentId: "p", prevSiblingId: "a", text: "bravo #go" },
    { id: "c", parentId: "p", prevSiblingId: "b", text: "charlie #go" },
  ]);
  await openSeededOutline(page, { path: "/?q=%23go", anchorId: "p" });
  await text(page, "c").nth(1).click();
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Tab");
  await expect(li(page, "b").nth(1)).toHaveAttribute("data-parent-id", "a");
  await expect(li(page, "b").nth(1)).toHaveAttribute("data-selected", "top");
  await expect(li(page, "c").nth(1)).toHaveAttribute("data-selected", "bottom");
  await expect(li(page, "b").nth(0)).not.toHaveAttribute("data-selected", /.*/);
  await page.keyboard.press("Shift+Tab");
  await expect(li(page, "b").nth(1)).toHaveAttribute("data-parent-id", "p");
  await expect(li(page, "b").nth(1)).toHaveAttribute("data-selected", "top");
  await expect(li(page, "c").nth(1)).toHaveAttribute("data-selected", "bottom");
  await page.keyboard.press("Escape");
  await expect(text(page, "b").nth(1)).toBeFocused();
});

test("a focus-retained row cannot leave an invisible selection after blur", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "alpha #go" },
    { id: "b", parentId: null, prevSiblingId: "a", text: "bravo #go" },
  ]);
  await openSeededOutline(page, { path: "/?q=%23go", anchorId: "a" });
  await text(page, "a").fill("no longer matching");
  await expect(text(page, "a")).toBeFocused();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "a")).toHaveCount(0);
  await expect(page.locator("li[data-selected]")).toHaveCount(0);
  await page.keyboard.press("Delete");
  await page.goto("/");
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["no longer matching", "bravo #go"]);
});

test("the first Shift+arrow press selects ONLY the focused node (entry never extends)", async ({
  page,
}) => {
  await load(page);
  await focus(page, "d");

  // Cursor on d, Shift+Up: d alone becomes selected -- entry does NOT reach up
  // into c. The caret is gone (selection mode has no caret).
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "d")).toHaveAttribute("data-selected", "single");
  await expect(li(page, "c")).not.toHaveAttribute("data-selected", /.*/);
  await expect(focused(page)).toHaveCount(0);

  // The SECOND press is what extends the run upward -> [c, d].
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
});

test("Shift+Down extends the run, Shift+Up shrinks toward the anchor", async ({
  page,
}) => {
  await load(page);
  await focus(page, "a");

  // First press enters selection on the focused node only.
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "a")).toHaveAttribute("data-selected", "single");
  // Caret is gone while selecting.
  await expect(focused(page)).toHaveCount(0);

  // Extend down -> [a, b].
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");

  // Extend to [a, b, c].
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "b")).toHaveAttribute("data-selected", "middle");
  await expect(li(page, "c")).toHaveAttribute("data-selected", "bottom");

  // Reverse direction shrinks back toward the anchor -> [a, b].
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");
  await expect(li(page, "c")).not.toHaveAttribute("data-selected", /.*/);
});

test("Shift extension is a no-op at the last sibling (never crosses parents)", async ({
  page,
}) => {
  await load(page);
  await focus(page, "d"); // last sibling

  await page.keyboard.press("Shift+ArrowDown");
  // Only d is selected; there is nothing below to extend into.
  await expect(li(page, "d")).toHaveAttribute("data-selected", "single");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "d")).toHaveAttribute("data-selected", "single");
});

test("at the sibling boundary, a single-root selection climbs to the parent and dives back into the child", async ({
  page,
}) => {
  await load(page, CHAIN);
  await focus(page, "aaa");

  // First press selects the focused node itself -- entering never climbs. aaa
  // is a leaf, so it's the only covered row.
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "aaa")).toHaveAttribute("data-selected", "single");

  // No upper sibling -> the selection moves UP to the parent. aa has a visible
  // child (aaa), so the windowed list tints BOTH rows now (2e-2) -- the slab
  // rounds at aa (top) and at aaa, its last visible descendant (bottom), not
  // just at the selected root.
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "aa")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "aaa")).toHaveAttribute("data-selected", "bottom");

  // Climb again to the top-level grandparent: the whole chain is covered.
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "aa")).toHaveAttribute("data-selected", "middle");
  await expect(li(page, "aaa")).toHaveAttribute("data-selected", "bottom");

  // At the top level there is no parent to climb to -> no-op.
  await page.keyboard.press("Shift+ArrowUp");
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");

  // Shift+Down dives back into the first visible child, one level per press.
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "aa")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "aaa")).toHaveAttribute("data-selected", "bottom");
  await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);

  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "aaa")).toHaveAttribute("data-selected", "single");
  await expect(li(page, "aa")).not.toHaveAttribute("data-selected", /.*/);
});

test("Tab indents the selected run under the previous sibling; Shift+Tab outdents it back", async ({
  page,
}) => {
  await load(page); // FLAT: alpha, bravo, charlie, delta
  await focus(page, "d");
  await page.keyboard.press("Shift+ArrowUp"); // enter -> [d]
  await page.keyboard.press("Shift+ArrowUp"); // extend -> [c, d] -- anchor d, focus c
  await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");

  // Tab: c and d become children of b, in order, and STAY selected.
  await page.keyboard.press("Tab");
  await expect(
    page.locator('li[data-node-id="c"][data-parent-id="b"]'),
  ).toBeVisible();
  await expect(
    page.locator('li[data-node-id="d"][data-parent-id="b"]'),
  ).toBeVisible();
  await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
  // Only alpha + bravo remain at the top level now.
  await expect(
    page.locator("li[data-node-id]:not([data-parent-id])"),
  ).toHaveCount(2);

  // Shift+Tab: outdent back to the top level, right after b, still selected.
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.locator("li[data-node-id]:not([data-parent-id])"),
  ).toHaveCount(4);
  await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["alpha", "bravo", "charlie", "delta"]);
});

test("Tab is a no-op when the run starts at the first child (nothing to indent under)", async ({
  page,
}) => {
  await load(page);
  await focus(page, "a"); // first sibling -- no previous sibling to indent under
  await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
  await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

  await page.keyboard.press("Tab");
  // Nothing moved; the selection persists at the top level.
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");
  await expect(
    page.locator("li[data-node-id]:not([data-parent-id])"),
  ).toHaveCount(4);
});

test("Cmd+A ladder: text -> node -> whole view", async ({ page }) => {
  await load(page);
  await focus(page, "a");

  // Rung 1: select all TEXT in the bullet (native), no node selection yet.
  await page.keyboard.press(`${MOD}+a`);
  expect(
    await text(page, "a").evaluate(() => window.getSelection()?.toString()),
  ).toBe("alpha");
  await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);

  // Rung 2: this node + its subtree (a single-root selection).
  await page.keyboard.press(`${MOD}+a`);
  await expect(li(page, "a")).toHaveAttribute("data-selected", "single");

  // Rung 3: the whole current view -- every top-level node.
  await page.keyboard.press(`${MOD}+a`);
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "b")).toHaveAttribute("data-selected", "middle");
  await expect(li(page, "c")).toHaveAttribute("data-selected", "middle");
  await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
});

test("Copy as Markdown copies the selected roots' subtrees", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await load(page);
  await focus(page, "a");
  await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
  await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

  await page.keyboard.press(`${MOD}+c`);
  await expect(page.getByText("Copied as Markdown")).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe("- alpha\n- bravo");
  const copy = page.getByRole("menuitem", { name: /^Copy as Markdown/ });
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(copy).toBeFocused();
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");
});

test("Backspace deletes the selected roots in one batch; undo restores", async ({
  page,
}) => {
  // Undo waits for the deletion's write acknowledgement before restoring.
  await seedOutline(page, FLAT, { postDelayMs: 300 });
  await openSeededOutline(page, { anchorId: "a" });
  await focus(page, "b");
  await page.keyboard.press("Shift+ArrowDown"); // enter -> [b]
  await page.keyboard.press("Shift+ArrowDown"); // extend -> [b, c]

  await page.keyboard.press("Backspace");
  await expect.poll(() => orderedTexts(page)).toEqual(["alpha", "delta"]);
  // Focus lands on the surviving row above the deleted block.
  await expect(focused(page)).toHaveText("alpha");

  await page.keyboard.press(`${MOD}+z`);
  await expect(page.locator(".outline-row .node-text")).toHaveText([
    "alpha",
    "bravo",
    "charlie",
    "delta",
  ]);
});

test("Escape clears the selection and returns the caret", async ({ page }) => {
  await load(page);
  await focus(page, "a");
  await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
  await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b], focus end = b

  await page.keyboard.press("Escape");
  await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);
  await expect(li(page, "b")).not.toHaveAttribute("data-selected", /.*/);
  // Caret returns to the moving (focus) end.
  await expect(focused(page)).toHaveText("bravo");
});

test("selection menu keyboard navigation preserves the slab, IME, and caret restoration", async ({
  page,
}) => {
  await load(page);
  await focus(page, "b");
  await page.keyboard.press(`${MOD}+a`);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("bravo");
  await page.keyboard.press(`${MOD}+a`);
  const menu = page.getByRole("menu", { name: "Selection actions" });
  const copy = menu.getByRole("menuitem", { name: /^Copy as Markdown/ });
  const move = menu.getByRole("menuitem", { name: /^Move/ });
  await expect(copy).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(move).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(copy).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(copy).toBeFocused();
  await page.keyboard.press("Home");
  await expect(copy).toBeFocused();
  await expect(li(page, "b")).toHaveAttribute("data-selected", "single");
  await expect(focused(page)).toHaveCount(0);

  // A cancelled selected-dot drag must leave keyboard ownership in the menu,
  // not strand focus on the bullet while the selection remains active.
  const dot = li(page, "b").locator(":scope > .outline-row .bullet");
  const box = (await dot.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const pressedPointer = await dot.evaluateHandle((el) => {
    const pointer = { pointerId: -1, pointerType: "" };
    el.addEventListener(
      "pointerdown",
      (event) => {
        // SAFETY: the browser's pointerdown event is a PointerEvent.
        const { pointerId, pointerType } = event as PointerEvent;
        Object.assign(pointer, { pointerId, pointerType });
      },
      { once: true },
    );
    return pointer;
  });
  await page.mouse.down();
  const pointer = await pressedPointer.jsonValue();
  await pressedPointer.dispose();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2);
  await expect(page.locator("body")).toHaveClass(/dragging-active/);
  await dot.dispatchEvent("pointercancel", pointer);
  await expect(page.locator("body")).not.toHaveClass(/dragging-active/);
  await page.mouse.up();
  await expect(copy).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(move).toBeFocused();
  await page.keyboard.press("Home");
  await expect(copy).toBeFocused();
  await expect(li(page, "b")).toHaveAttribute("data-selected", "single");

  // Real IME candidate windows are OS-owned. Exercise the two browser event
  // shapes explicitly: neither may navigate, activate, delete, or dismiss.
  for (const key of ["ArrowDown", "Enter", " ", "Backspace", "Escape"]) {
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      await copy.dispatchEvent("keydown", { key, ...composition });
      await expect(copy).toBeFocused();
      await expect(li(page, "b")).toHaveAttribute("data-selected", "single");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  }

  // A global editor shortcut still opens its own control. Its Escape must not
  // clear the underlying selection before that control restores menu focus.
  await page.keyboard.press(`${MOD}+k`);
  const commandCenter = page.getByRole("dialog", { name: "Command center" });
  await expect(commandCenter.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(commandCenter).toHaveCount(0);
  await expect(copy).toBeFocused();
  await expect(li(page, "b")).toHaveAttribute("data-selected", "single");

  // Bulk selection and indentation still work from a focused menu item.
  await page.keyboard.press("Shift+ArrowDown");
  await expect(li(page, "b")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "c")).toHaveAttribute("data-selected", "bottom");
  await page.keyboard.press("Tab");
  await expect(li(page, "b")).toHaveAttribute("data-parent-id", "a");
  await expect(li(page, "c")).toHaveAttribute("data-parent-id", "a");
  await page.keyboard.press("Shift+Tab");
  await expect(li(page, "b")).not.toHaveAttribute("data-parent-id", /.*/);
  await expect(li(page, "c")).not.toHaveAttribute("data-parent-id", /.*/);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(text(page, "c")).toBeFocused();
  await page.keyboard.type("!");
  await expect(text(page, "c")).toHaveText("charlie!");
  await page.keyboard.press("ArrowDown");
  await expect(text(page, "d")).toBeFocused();

  // Typeahead and Enter activate a menu action, not editor input.
  await page.keyboard.press("Shift+ArrowUp");
  await expect(copy).toBeFocused();
  await page.keyboard.press("t");
  await expect(menu.getByRole("menuitem", { name: "To-do" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(li(page, "d").locator(".checkbox")).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["alpha", "bravo", "charlie!", "delta"]);
});

test("a printable key never replaces the selection", async ({ page }) => {
  await load(page);
  await focus(page, "a");
  await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
  await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

  await page.keyboard.press("x");
  // Selection persists; no text was replaced.
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
  await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");
  await expect
    .poll(() => orderedTexts(page))
    .toEqual(["alpha", "bravo", "charlie", "delta"]);
});

test("a click leaves selection mode", async ({ page }) => {
  await load(page);
  await focus(page, "a");
  await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
  await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]
  await expect(li(page, "a")).toHaveAttribute("data-selected", "top");

  await text(page, "d").click();
  await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);
  await expect(text(page, "d")).toBeFocused();
});

test("actions menu: Move relocates the whole run under one destination", async ({
  page,
}) => {
  await load(page);
  await focus(page, "a");
  await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
  await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

  const menu = page.getByRole("menu", { name: "Selection actions" });
  // Anchor to the label: "Send to Today"'s description also contains "Move".
  await expect(
    menu.getByRole("menuitem", { name: /^Copy as Markdown/ }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /^Move/ })).toBeFocused();
  await page.keyboard.press("Space");

  // The destination picker opens; pick delta (not in the moved subtrees).
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("delta");
  await dialog.getByRole("option", { name: "delta" }).click();

  await expect(page.getByText("Moved 2 nodes to delta")).toBeVisible();
  // Both moved roots are now children of delta (their data-parent-id).
  await expect(
    page.locator('li[data-node-id="a"][data-parent-id="d"]'),
  ).toBeVisible();
  await expect(
    page.locator('li[data-node-id="b"][data-parent-id="d"]'),
  ).toBeVisible();
  // They are no longer top-level (only charlie + delta remain at the top).
  await expect(
    page.locator("li[data-node-id]:not([data-parent-id])"),
  ).toHaveCount(2);
});

test("actions menu: To-do converts every selected root in one step", async ({
  page,
}) => {
  await load(page);
  await focus(page, "a");
  await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
  await page.keyboard.press("Shift+ArrowDown"); // extend -> [a, b]

  // The actions menu auto-appears anchored to the active (focus) edge.
  const menu = page.getByRole("menu", { name: "Selection actions" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "To-do" }).click();

  // Both selected roots are now tasks (a checkbox appears on each).
  await expect(li(page, "a").locator(".checkbox")).toBeVisible();
  await expect(li(page, "b").locator(".checkbox")).toBeVisible();
  // The untouched siblings stay plain bullets.
  await expect(li(page, "c").locator(".checkbox")).toHaveCount(0);
});

test("actions menu follows the active edge DOWN, anchored below the newest node", async ({
  page,
}) => {
  await load(page);
  await focus(page, "a");

  const menu = page.getByRole("menu", { name: "Selection actions" });
  const rowBox = async (id: string) =>
    (await page
      .locator(`li[data-node-id="${id}"] > .outline-row`)
      .boundingBox())!;
  const menuBox = async () => (await menu.boundingBox())!;

  // Enter on a single node: the menu sits just below the focused row (there's
  // plenty of room below in the default tall viewport, so no flip).
  await page.keyboard.press("Shift+ArrowDown"); // -> [a], focus a
  await expect(menu).toBeVisible();
  let row = await rowBox("a");
  let m = await menuBox();
  expect(m.y).toBeGreaterThanOrEqual(row.y + row.height - 1);
  expect(m.y).toBeLessThanOrEqual(row.y + row.height + 16);
  const yBelowA = m.y;

  // Extend down twice: the menu drops to the NEW bottom node each time, never
  // parking over the run's text up top.
  await page.keyboard.press("Shift+ArrowDown"); // -> [a, b], focus b
  await page.keyboard.press("Shift+ArrowDown"); // -> [a, b, c], focus c
  await expect
    .poll(async () => (await menuBox()).y)
    .toBeGreaterThan(yBelowA + 10);
  row = await rowBox("c");
  m = await menuBox();
  expect(m.y).toBeGreaterThan(yBelowA + 10); // it moved down with the selection
  expect(m.y).toBeGreaterThanOrEqual(row.y + row.height - 1); // below c
  expect(m.y).toBeLessThanOrEqual(row.y + row.height + 16);
});

test("actions menu stays fully on screen when the run grows to the TOP edge", async ({
  page,
}) => {
  await load(page);
  await focus(page, "d");

  // Grow the run all the way up so the focus lands on the top-most row, where
  // the old top-anchored menu clipped off the top of the viewport.
  await page.keyboard.press("Shift+ArrowUp"); // -> [d]
  await page.keyboard.press("Shift+ArrowUp"); // -> [c, d]
  await page.keyboard.press("Shift+ArrowUp"); // -> [b, c, d]
  await page.keyboard.press("Shift+ArrowUp"); // -> [a, b, c, d], focus a (top)

  const menu = page.getByRole("menu", { name: "Selection actions" });
  await expect(menu).toBeVisible();
  // floating-ui flips the menu below the top node rather than letting it clip:
  // the whole box is within the viewport (the bug in the report).
  expectInViewport((await menu.boundingBox())!, page.viewportSize()!);
});

test("actions menu stays on screen extending DOWN past the fold", async ({
  page,
}) => {
  // A short viewport so the lower rows sit past the fold.
  await page.setViewportSize({ width: 1000, height: 420 });
  await load(page, TALL);
  await focus(page, "n0");

  await page.keyboard.press("Shift+ArrowDown"); // enter -> [n0]
  for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowDown");

  const menu = page.getByRole("menu", { name: "Selection actions" });
  await expect(menu).toBeVisible();
  // shift()/flip() keep the menu in view even though the run runs past the fold.
  expectInViewport((await menu.boundingBox())!, page.viewportSize()!);
});
