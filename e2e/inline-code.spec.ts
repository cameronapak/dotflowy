import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Inline code (`` `code` ``) is a FOLDING token (ADR 0025's reveal-on-proximity,
// shared with emphasis + links): the backticks hide (the run folds to a clean
// <code> atom) and reveal as real, dimmed, walk-through text only when the caret
// is within/adjacent.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

// Place the caret at a SOURCE offset, walking the live DOM like the app's
// setCaretOffset: text nodes add their length; an atom (any element with
// `data-src`) adds its `data-src-len` and the caret snaps to its edge.
async function caretAtSource(page: Page, id: string, target: number) {
  await text(page, id).evaluate((el, target) => {
    const sel = window.getSelection();
    if (!sel) return;
    let remaining = target as number;
    let placed = false;
    const visit = (node: Node): void => {
      if (placed) return;
      if (node.nodeType === 3 /* text */) {
        const len = node.textContent?.length ?? 0;
        if (remaining <= len) {
          const r = document.createRange();
          r.setStart(node, remaining);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          placed = true;
        } else remaining -= len;
        return;
      }
      if (node.nodeType === 1 && (node as HTMLElement).hasAttribute("data-src")) {
        const e = node as HTMLElement;
        const len =
          Number(e.getAttribute("data-src-len")) ||
          (e.getAttribute("data-src") ?? "").length;
        if (remaining < len) {
          const parent = e.parentNode!;
          const idx = Array.prototype.indexOf.call(parent.childNodes, e);
          const r = document.createRange();
          r.setStart(parent, remaining === 0 ? idx : idx + 1);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          placed = true;
          return;
        }
        remaining -= len;
        return;
      }
      node.childNodes.forEach(visit);
    };
    visit(el);
    if (!placed) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }, target);
}

const codeEl = (page: Page, id: string) => text(page, id).locator("code");

test.describe("Inline code: fold + reveal on proximity", () => {
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
    expect(await text(page, "n").textContent()).toBe("a snip b");
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
    await expect(text(page, "n").locator("code[data-code-reveal]")).toHaveCount(1);
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
});
