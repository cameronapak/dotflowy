import { expect, test, type Page } from "@playwright/test";

import { placeCaret, seedOutline, text, type SeedNode } from "./fixtures";

// Inline code (`` `code` ``) is a FOLDING token (ADR 0025's reveal-on-proximity,
// shared with emphasis + links): the backticks hide (the run folds to a clean
// <code> atom) and reveal as real, dimmed, walk-through text only when the caret
// is within/adjacent.

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

// Place the caret at a SOURCE offset, walking the live DOM like the app's
// setCaretOffset: text nodes add their length; an atom (any element with
// `data-src`) adds its `data-src-len` and the caret snaps to its edge.
async function caretAtSource(page: Page, id: string, target: number) {
  await placeCaret(text(page, id), target);
}

const codeEl = (page: Page, id: string) => text(page, id).locator("code");

test("a `run` folds to <code> with the backticks hidden and source in data-src", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "a `snip` b" },
  ]);
  await expect(codeEl(page, "n")).toHaveText("snip");
  await expect(codeEl(page, "n")).toHaveAttribute("data-src", "`snip`");
  await expect(codeEl(page, "n")).toHaveAttribute("contenteditable", "false");
  // Backticks hidden while blurred: the visible line reads "a snip b".
  await expect.poll(() => text(page, "n").textContent()).toBe("a snip b");
});

test("caret on the run reveals the backticks as REAL, dimmed text (not an atom)", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "`snip`" },
  ]);
  await text(page, "n").click();
  await caretAtSource(page, "n", 6); // end of `snip` (in [0, 6]) -> reveal
  await expect.poll(() => text(page, "n").textContent()).toBe("`snip`");
  // The backticks are dimmed .md-punct text INSIDE the <code> box, and the
  // <code> is no longer an atom (no data-src).
  await expect(text(page, "n").locator("code[data-code-reveal]")).toHaveCount(
    1,
  );
  await expect(codeEl(page, "n").locator(".md-punct")).toHaveCount(2);
  await expect(codeEl(page, "n")).not.toHaveAttribute("data-src", /.*/);
});

test("the caret walks INSIDE the fence -- `snip|` before the closing backtick", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "`snip`" },
  ]);
  await text(page, "n").click();
  await caretAtSource(page, "n", 6);
  await expect.poll(() => text(page, "n").textContent()).toBe("`snip`");
  // Offset 5 = between the interior and the closing backtick. A real caret
  // stop only because the backtick is real text, not a CSS pseudo-element.
  await caretAtSource(page, "n", 5);
  await page.keyboard.type("X");
  // The char landed before the closing backtick: source is "`snipX`" (the
  // revealed <code> now reads "`snipX`" -- backticks included, since they live
  // inside it).
  await expect.poll(() => text(page, "n").textContent()).toBe("`snipX`");
  await expect(codeEl(page, "n")).toHaveText("`snipX`");
});

test("moving the caret away re-folds the run", async ({ page }) => {
  await load(page, [
    { id: "a", parentId: null, prevSiblingId: null, text: "`snip`" },
    { id: "b", parentId: null, prevSiblingId: "a", text: "plain" },
  ]);
  await text(page, "a").click();
  await caretAtSource(page, "a", 6);
  await expect.poll(() => text(page, "a").textContent()).toBe("`snip`");
  await text(page, "b").click();
  await expect.poll(() => text(page, "a").textContent()).toBe("snip");
});

test("a #tag inside a code run stays code (precedence holds)", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "`a #b c`" },
  ]);
  // The whole `a #b c` is one code run; the #b never becomes a tag chip.
  await expect(codeEl(page, "n")).toHaveText("a #b c");
  await expect(text(page, "n").locator("[data-tag]")).toHaveCount(0);
});
