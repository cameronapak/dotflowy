import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Emphasis plugin (ADR 0025). Inline `*italic*`, `**bold**`, `~~strike~~`, and
// Bear-style `~underline~` render as FOLDING tokens (modelled on the rich-link
// fold): the markers hide (the run folds to a clean styled atom) and reveal as
// REAL, walk-through text only when the caret is within/adjacent to the run.
// v1 is flat: no nesting.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

// The styled element for one emphasis kind on `id`'s text. `em`/`strong`/`del`/
// `u` are the host tags -- present whether the run is folded (an atom carrying
// the source in `data-src`) or revealed (wrapped by `.emphasis-reveal`, markers
// as sibling `.md-punct` text).
const run = (page: Page, id: string, tag: "em" | "strong" | "del" | "u") =>
  text(page, id).locator(tag);

// Drop the caret at a SOURCE offset within `id`'s text span, walking the live
// DOM exactly as the app's setCaretOffset does: a text node contributes its
// length; an ATOM (any element with `data-src`, e.g. a folded run) contributes
// its `data-src-len` and the caret snaps to its edge. On the REVEALED DOM the
// markers are ordinary text, so an offset inside the run lands between real
// characters -- which is the whole point.
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
          // Inside an atom -- snap to its edge (before at 0, else after).
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

test.describe("Inline emphasis: fold when blurred (ADR 0025)", () => {
  test("a *run* folds to <em> with the marker hidden and the source in data-src", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "a *hi* b" },
    ]);
    await expect(run(page, "n", "em")).toHaveText("hi");
    // Folded = one atom: contenteditable=false, full source in data-src, markers
    // NOT in the DOM text (the visible line reads "a hi b").
    await expect(run(page, "n", "em")).toHaveAttribute("data-src", "*hi*");
    await expect(run(page, "n", "em")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    expect(await text(page, "n").textContent()).toBe("a hi b");
  });

  test("a _run_ folds to the same <em> as *run* (underscore italic)", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "a _hi_ b" },
    ]);
    await expect(run(page, "n", "em")).toHaveText("hi");
    // Same folded atom shape as the asterisk form: source in data-src (`_hi_`),
    // markers hidden (the visible line reads "a hi b").
    await expect(run(page, "n", "em")).toHaveAttribute("data-src", "_hi_");
    expect(await text(page, "n").textContent()).toBe("a hi b");
  });

  test("intraword underscores are NOT emphasis (snake_case stays literal)", async ({
    page,
  }) => {
    await load(page, [
      {
        id: "n",
        parentId: null,
        prevSiblingId: null,
        text: "call foo_bar_baz()",
      },
    ]);
    await expect(run(page, "n", "em")).toHaveCount(0);
    expect(await text(page, "n").textContent()).toBe("call foo_bar_baz()");
  });

  test("**bold**, ~~strike~~, ~underline~ each fold into their host tag", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "**b** ~~s~~ ~u~" },
    ]);
    await expect(run(page, "n", "strong")).toHaveText("b");
    await expect(run(page, "n", "del")).toHaveText("s");
    await expect(run(page, "n", "u")).toHaveText("u");
    // All markers hidden while blurred.
    expect(await text(page, "n").textContent()).toBe("b s u");
  });

  test("prefix disambiguation: **bold** wins over *italic* on the same span", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "**bold**" },
    ]);
    await expect(run(page, "n", "strong")).toHaveText("bold");
    await expect(run(page, "n", "em")).toHaveCount(0);
  });

  test("flat-v1: `***triple***` does not nest -- bold wins, outer `*` is literal", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "***x***" },
    ]);
    await expect(run(page, "n", "strong")).toHaveText("x");
    // The visible text is "*x*" (one literal `*` on each side of the bold run).
    expect(await text(page, "n").textContent()).toBe("*x*");
  });

  test("an unclosed marker renders as literal text", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "*unclosed" },
    ]);
    await expect(run(page, "n", "em")).toHaveCount(0);
    expect(await text(page, "n").textContent()).toBe("*unclosed");
  });

  test("two emphasis kinds on one line coexist", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "*i* and **b**" },
    ]);
    await expect(run(page, "n", "em")).toHaveText("i");
    await expect(run(page, "n", "strong")).toHaveText("b");
  });
});

test.describe("Inline emphasis: reveal + caret walk-through", () => {
  test("caret on the run reveals the markers as REAL text (not an atom)", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "*italics*" },
    ]);
    // Focus, then drop the caret at the run's end (offset 9). Being in [0, 9]
    // reveals it.
    await text(page, "n").click();
    await caretAtSource(page, "n", 9);
    // Revealed: the whole source shows, markers are dimmed .md-punct text
    // siblings, and the <em> is no longer an atom (no data-src).
    await expect.poll(() => text(page, "n").textContent()).toBe("*italics*");
    await expect(text(page, "n").locator(".emphasis-reveal")).toHaveCount(1);
    await expect(text(page, "n").locator(".md-punct")).toHaveCount(2);
    await expect(run(page, "n", "em")).not.toHaveAttribute("data-src", /.*/);
  });

  test("the caret lands INSIDE the closing fence -- `*italics|*` is reachable", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "*italics*" },
    ]);
    await text(page, "n").click();
    // Reveal first (caret at the end).
    await caretAtSource(page, "n", 9);
    await expect.poll(() => text(page, "n").textContent()).toBe("*italics*");
    // Now place the caret at source offset 8 -- BETWEEN the interior and the
    // closing `*` (the `*italics|*` position Cam specified). If the marker were
    // a virtual/CSS pseudo-element this position would be unreachable; because
    // it is real text, typing here lands the char before the closing marker.
    await caretAtSource(page, "n", 8);
    await page.keyboard.type("Z");
    await expect.poll(() => text(page, "n").textContent()).toBe("*italicsZ*");
    // Still one bold... italic run -- the interior grew, the marker stayed put.
    await expect(run(page, "n", "em")).toHaveText("italicsZ");
  });

  test("moving the caret away re-folds the run", async ({ page }) => {
    await load(page, [
      { id: "a", parentId: null, prevSiblingId: null, text: "*italics*" },
      { id: "b", parentId: null, prevSiblingId: "a", text: "plain" },
    ]);
    await text(page, "a").click();
    await caretAtSource(page, "a", 9);
    await expect.poll(() => text(page, "a").textContent()).toBe("*italics*");
    // Focus the sibling: the first run folds again (markers hidden).
    await text(page, "b").click();
    await expect.poll(() => text(page, "a").textContent()).toBe("italics");
  });
});

test.describe("Inline emphasis: creation", () => {
  test("Cmd+B wraps a selection in **bold**", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
    ]);
    await text(page, "n").click();
    await page.keyboard.press("Meta+a"); // rung 1: native text select-all
    await page.keyboard.press("Meta+b");
    await expect(run(page, "n", "strong")).toHaveText("alphabravo");
    // The browser's native bold (execCommand) must NOT have fired -- no stray
    // <b>; our source-level wrap produced a real `**...**` run.
    await expect(text(page, "n").locator("b")).toHaveCount(0);
  });

  // Quarantined (#217): flaky under --workers=2 parallel contention -- the
  // select-all/keypress races the load and the wrap lands on a collapsed
  // caret. Passes reliably at --workers=1. Un-quarantine per the issue.
  test.fixme("Cmd+I / Cmd+U / Cmd+Shift+X wrap a selection in each kind", async ({
    page,
  }) => {
    for (const [combo, tag] of [
      ["Meta+i", "em"],
      ["Meta+u", "u"],
      ["Meta+Shift+x", "del"],
    ] as const) {
      await load(page, [
        { id: "n", parentId: null, prevSiblingId: null, text: "word" },
      ]);
      await text(page, "n").click();
      await page.keyboard.press("Meta+a");
      await page.keyboard.press(combo);
      await expect(run(page, "n", tag)).toHaveText("word");
    }
  });

  test("/bold inserts empty markers with the caret inside", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "" },
    ]);
    await text(page, "n").click();
    await page.keyboard.type("/bold");
    await page.keyboard.press("Enter");
    await page.keyboard.type("X");
    await expect(run(page, "n", "strong")).toHaveText("X");
  });
});
