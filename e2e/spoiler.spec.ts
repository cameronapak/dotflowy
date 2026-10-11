import { expect, test, type Page } from "@playwright/test";

import { placeCaret, seedOutline, text, type SeedNode } from "./fixtures";

// Spoiler plugin (ADR 0043). `||text||` renders as the sixth FOLDING token:
// folded, the run is one atomic span skinned as an opaque bar (fences hidden);
// revealed (caret on the run), the `||` fences show as real walk-through text
// INSIDE the container (the inline-code fence-in-container model). Creation via
// /spoiler + Mod+Shift+S + the desktop toolbar's Eye button, all through the
// shared plain-marker toggle. Redaction is Worker-side (worker/outline-ops.ts),
// covered by worker/outline-ops.test.ts — e2e can't reach it (seedOutline mocks
// the Worker).

const bar = (page: Page, id: string) =>
  text(page, id).locator("span[data-spoiler]");
const toolbar = (page: Page) => page.locator("[data-format-toolbar]");
const btn = (page: Page, label: string) =>
  toolbar(page).getByRole("button", { name: label, exact: true });

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

// Drop the caret at a SOURCE offset within `id`'s span (the highlight spec's
// helper): a text node contributes its length; an ATOM (data-src) contributes
// its data-src-len and the caret snaps to its edge.
async function caretAtSource(page: Page, id: string, target: number) {
  await placeCaret(text(page, id), target);
}

async function selectAll(page: Page, id: string) {
  await text(page, id).click();
  await text(page, id).evaluate((el) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test("a ||run|| folds to an opaque-bar atom spanning the full source", async ({
  page,
}) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "the answer is ||42||",
    },
  ]);
  // The bar's glyphs are the FULL source `||42||` (rendered transparent) so
  // the bar reserves the same width the revealed `||42||` occupies — entering
  // the run swaps bar<->text with no reflow. `text-transparent` hides them.
  await expect(bar(page, "n")).toHaveText("||42||");
  await expect(bar(page, "n")).toHaveClass(/text-transparent/);
  await expect(bar(page, "n")).toHaveAttribute("data-src", "||42||");
  await expect(bar(page, "n")).toHaveAttribute("contenteditable", "false");
});

test("an unclosed fence renders as literal text", async ({ page }) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "||unclosed" },
  ]);
  await expect(bar(page, "n")).toHaveCount(0);
  await expect.poll(() => text(page, "n").textContent()).toBe("||unclosed");
});

test("a code run shields its interior — `||x||` inside code stays literal", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "`||x||`" },
  ]);
  // Code wins (precedence 10 < 40): the run is a <code> atom, no spoiler bar.
  await expect(bar(page, "n")).toHaveCount(0);
  await expect(text(page, "n").locator("code")).toHaveCount(1);
});

test("caret on the run reveals the `||` fences inside the container", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "||secret||" },
  ]);
  await text(page, "n").click();
  // Source length: 2 fences + 6 interior + 2 fences = 10.
  await caretAtSource(page, "n", 10);
  await expect.poll(() => text(page, "n").textContent()).toBe("||secret||");
  await expect(text(page, "n").locator("[data-spoiler-reveal]")).toHaveCount(1);
  // Fences render as dimmed walk-through punctuation inside the container.
  await expect(
    text(page, "n").locator("[data-spoiler-reveal] .md-punct"),
  ).toHaveCount(2);
  // The revealed run is no longer an atom.
  await expect(bar(page, "n")).toHaveCount(0);
});

test("moving the caret away re-folds the run to the bar", async ({ page }) => {
  await load(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "||hi||" },
    { id: "b", parentId: null, prevSiblingId: "a", text: "plain" },
  ]);
  await text(page, "a").click();
  await caretAtSource(page, "a", 6);
  await expect.poll(() => text(page, "a").textContent()).toBe("||hi||");
  await text(page, "b").click();
  // Re-folded: the bar is back (its transparent glyphs are still the full
  // source, so the visible line text is unchanged from the revealed form).
  await expect(bar(page, "a")).toHaveAttribute("data-src", "||hi||");
  await expect(bar(page, "a")).toHaveClass(/text-transparent/);
});

test("Mod+Shift+S wraps a selection in ||...||", async ({ page }) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
  ]);
  await selectAll(page, "n");
  await page.keyboard.press("ControlOrMeta+Shift+s");
  // Caret sits in the fresh run, so it's REVEALED: fences inside the container.
  await expect(text(page, "n").locator("[data-spoiler-reveal]")).toHaveText(
    "||alphabravo||",
  );
});

test("/spoiler inserts empty fences with the caret inside", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "" },
  ]);
  await text(page, "n").click();
  await page.keyboard.type("/spoiler");
  await page.keyboard.press("Enter");
  await page.keyboard.type("X");
  await expect(text(page, "n").locator("[data-spoiler-reveal]")).toHaveText(
    "||X||",
  );
});

test("the toolbar's EyeOff button wraps + lights when inside a spoiler", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
  ]);
  await selectAll(page, "n");
  await expect(toolbar(page)).toBeVisible();
  await btn(page, "Spoiler").click();
  // Toggled ON: a revealed `||...||` run (the toolbar keeps the selection).
  await expect(text(page, "n").locator("[data-spoiler-reveal]")).toHaveText(
    "||alphabravo||",
  );
  await expect(btn(page, "Spoiler")).toHaveAttribute("aria-pressed", "true");
  // Toggle OFF: back to plain text.
  await btn(page, "Spoiler").click();
  await expect(text(page, "n").locator("[data-spoiler-reveal]")).toHaveCount(0);
  await expect(text(page, "n")).toHaveText("alphabravo");
});

test("Cmd+K finds a node by text hidden inside its spoiler", async ({
  page,
}) => {
  await load(page, [
    {
      id: "a",
      parentId: null,
      prevSiblingId: null,
      text: "plot: ||Bob did it||",
    },
    { id: "b", parentId: null, prevSiblingId: "a", text: "unrelated" },
  ]);
  await page.keyboard.press("ControlOrMeta+k");
  // flattenInline strips the fences but KEEPS the interior, so your own fuzzy
  // search matches "Bob" even though it's hidden behind the bar (ADR 0043).
  await page.keyboard.type("Bob did");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Bob did it")).toBeVisible();
});
