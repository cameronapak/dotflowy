import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Highlight plugin (ADR 0035). `==text==` renders as a FOLDING token (the
// emphasis model): fences hidden while folded, revealed as real walk-through
// text when the caret is on the run. Color rides IN the source as an optional
// leading circle emoji (`==🔴urgent==`), hidden when folded; a bare run is
// blue. Right-click recolors by rewriting the emoji in the source.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

const mark = (page: Page, id: string) => text(page, id).locator("mark");

// Drop the caret at a SOURCE offset within `id`'s text span (the emphasis
// spec's helper): a text node contributes its length; an ATOM (data-src)
// contributes its data-src-len and the caret snaps to its edge.
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
      if (
        node.nodeType === 1 &&
        (node as HTMLElement).hasAttribute("data-src")
      ) {
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

test.describe("Highlight: fold when blurred (ADR 0035)", () => {
  test("a bare ==run== folds to a blue <mark> with fences hidden", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "a ==hi== b" },
    ]);
    await expect(mark(page, "n")).toHaveText("hi");
    await expect(mark(page, "n")).toHaveAttribute("data-highlight", "blue");
    await expect(mark(page, "n")).toHaveAttribute("data-src", "==hi==");
    await expect(mark(page, "n")).toHaveAttribute("contenteditable", "false");
    expect(await text(page, "n").textContent()).toBe("a hi b");
  });

  test("a color emoji names the color and is HIDDEN while folded", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "==🔴urgent==" },
    ]);
    await expect(mark(page, "n")).toHaveText("urgent");
    await expect(mark(page, "n")).toHaveAttribute("data-highlight", "red");
    // The emoji is not in the visible line -- the Lettera trick.
    expect(await text(page, "n").textContent()).toBe("urgent");
  });

  test("an unclosed fence renders as literal text", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "==unclosed" },
    ]);
    await expect(mark(page, "n")).toHaveCount(0);
    expect(await text(page, "n").textContent()).toBe("==unclosed");
  });
});

test.describe("Highlight: reveal + re-fold", () => {
  test("caret on the run reveals fences; the emoji stays hidden behind the pen atom", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "==🔴urgent==" },
    ]);
    await text(page, "n").click();
    // Source length: 2 fences + 2 (emoji is one astral code point = 2 UTF-16
    // units) + 6 interior + 2 fences = 12.
    await caretAtSource(page, "n", 12);
    // The emoji is NEVER displayed -- the visible text is fences + interior;
    // the pen affordance carries the emoji as its atom source, so readSource
    // (and copy/export) still reconstructs `==🔴urgent==`.
    await expect.poll(() => text(page, "n").textContent()).toBe("==urgent==");
    await expect(
      text(page, "n").locator("[data-highlight-reveal]"),
    ).toHaveCount(1);
    await expect(
      text(page, "n").locator(".highlight-pen-icon"),
    ).toHaveAttribute("data-src", "🔴");
    // Fences render INSIDE the painted <mark> (the code-box model).
    await expect(text(page, "n").locator("mark .md-punct")).toHaveCount(2);
    // The revealed <mark> itself is no longer an atom.
    await expect(mark(page, "n")).not.toHaveAttribute("data-src", /.*/);
  });

  test("typing in a revealed colored run keeps the hidden emoji (color survives edits)", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "==🔴urgent==" },
    ]);
    await text(page, "n").click();
    await caretAtSource(page, "n", 12);
    await expect.poll(() => text(page, "n").textContent()).toBe("==urgent==");
    // Caret between the interior and the closing fence: `==🔴urgent|==`.
    await caretAtSource(page, "n", 10);
    await page.keyboard.type("!");
    await expect.poll(() => text(page, "n").textContent()).toBe("==urgent!==");
    // The pen atom carried the emoji through the edit -- still red.
    await expect(mark(page, "n")).toHaveAttribute("data-highlight", "red");
    await expect(
      text(page, "n").locator(".highlight-pen-icon"),
    ).toHaveAttribute("data-src", "🔴");
  });

  test("moving the caret away re-folds the run", async ({ page }) => {
    await load(page, [
      { id: "a", parentId: null, prevSiblingId: null, text: "==hi==" },
      { id: "b", parentId: null, prevSiblingId: "a", text: "plain" },
    ]);
    await text(page, "a").click();
    await caretAtSource(page, "a", 6);
    await expect.poll(() => text(page, "a").textContent()).toBe("==hi==");
    await text(page, "b").click();
    await expect.poll(() => text(page, "a").textContent()).toBe("hi");
  });
});

test.describe("Highlight: creation", () => {
  test("Cmd+Shift+H wraps a selection in ==...==", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
    ]);
    await text(page, "n").click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Meta+Shift+h");
    // The caret sits in the fresh run, so it's REVEALED: fences inside the mark.
    await expect(mark(page, "n")).toHaveText("==alphabravo==");
    await expect(mark(page, "n")).toHaveAttribute("data-highlight", "blue");
  });

  test("/highlight inserts empty fences with the caret inside", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "" },
    ]);
    await text(page, "n").click();
    await page.keyboard.type("/highlight");
    await page.keyboard.press("Enter");
    await page.keyboard.type("X");
    // Caret inside the run -- revealed, fences inside the mark.
    await expect(mark(page, "n")).toHaveText("==X==");
  });
});

test.describe("Highlight: pen affordance (Bear-style)", () => {
  test("the revealed run's pen opens the color menu; picking recolors", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "==hi==" },
    ]);
    // Reveal (caret in the run) -- the pen leads the run after the opening ==.
    await text(page, "n").click();
    await caretAtSource(page, "n", 6);
    await expect.poll(() => text(page, "n").textContent()).toBe("==hi==");
    const pen = text(page, "n").locator(".highlight-pen-icon");
    await expect(pen).toBeVisible();
    await pen.click();
    const menu = page.locator("[data-highlight-menu]");
    await expect(menu).toBeVisible();
    // The current color's row is checked.
    await expect(
      menu.getByRole("menuitemradio", { name: "blue" }),
    ).toHaveAttribute("aria-checked", "true");
    await menu.getByRole("menuitemradio", { name: "green" }).click();
    await expect(mark(page, "n")).toHaveAttribute("data-highlight", "green");
    await expect
      .poll(async () =>
        mark(page, "n").evaluate(
          (el) =>
            el.getAttribute("data-src") ??
            el.closest("[data-highlight-reveal]")?.textContent,
        ),
      )
      .toBe("==🟢hi==");
  });
});

test.describe("Highlight: right-click recolor (source rewrite)", () => {
  test("picking a color splices its emoji into the source", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "a ==hi== b" },
    ]);
    await mark(page, "n").click({ button: "right" });
    const menu = page.locator("[data-highlight-menu]");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitemradio", { name: "red" }).click();
    await expect(mark(page, "n")).toHaveAttribute("data-highlight", "red");
    await expect(mark(page, "n")).toHaveText("hi");
    // Still folded -- the emoji stays hidden.
    expect(await text(page, "n").textContent()).toBe("a hi b");
  });

  test("picking the default color emits the BARE run (clean markdown)", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "==🔴urgent==" },
    ]);
    await mark(page, "n").click({ button: "right" });
    await page
      .locator("[data-highlight-menu]")
      .getByRole("menuitemradio", { name: "blue" })
      .click();
    await expect(mark(page, "n")).toHaveAttribute("data-highlight", "blue");
    await expect(mark(page, "n")).toHaveAttribute("data-src", "==urgent==");
  });

  test("Remove highlight strips the run to its interior", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "a ==🟢go== b" },
    ]);
    await mark(page, "n").click({ button: "right" });
    await page
      .locator("[data-highlight-menu]")
      .getByRole("menuitem", { name: "Remove highlight" })
      .click();
    await expect(mark(page, "n")).toHaveCount(0);
    await expect(text(page, "n")).toHaveText("a go b");
  });
});
