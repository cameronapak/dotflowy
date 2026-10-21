import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  text,
  type SeedNode,
} from "./fixtures";

// Emphasis plugin (ADR 0025). Inline `*italic*`, `**bold**`, `~~strike~~`, and
// Bear-style `~underline~` render as FOLDING tokens (modelled on the rich-link
// fold): the markers hide (the run folds to a clean styled atom) and reveal as
// REAL, walk-through text only when the caret is within/adjacent to the run.
// v1 is flat: no nesting.

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await openSeededOutline(page, { anchorId: tree[0]!.id });
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
  await placeCaret(text(page, id), target);
}

test("folded emphasis preserves each delimiter, flat precedence, and literal near-misses", async ({
  page,
}) => {
  const sources = [
    ["asterisk", "a *hi* b"],
    ["underscore", "a _hi_ b"],
    ["intraword", "call foo_bar_baz()"],
    ["kinds", "**b** ~~s~~ ~u~"],
    ["bold", "**bold**"],
    ["triple", "***x***"],
    ["unclosed", "*unclosed"],
    ["mixed", "*i* and **b**"],
  ];
  await load(
    page,
    sources.map(([id, source], i) => ({
      id: id!,
      parentId: null,
      prevSiblingId: i ? sources[i - 1]![0]! : null,
      text: source!,
    })),
  );
  await expect(run(page, "asterisk", "em")).toHaveText("hi");
  // Folded = one atom: contenteditable=false, full source in data-src, markers
  // NOT in the DOM text (the visible line reads "a hi b").
  await expect(run(page, "asterisk", "em")).toHaveAttribute("data-src", "*hi*");
  await expect(run(page, "asterisk", "em")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await expect.poll(() => text(page, "asterisk").textContent()).toBe("a hi b");
  await expect(run(page, "underscore", "em")).toHaveText("hi");
  // Same folded atom shape as the asterisk form: source in data-src (`_hi_`),
  // markers hidden (the visible line reads "a hi b").
  await expect(run(page, "underscore", "em")).toHaveAttribute(
    "data-src",
    "_hi_",
  );
  await expect
    .poll(() => text(page, "underscore").textContent())
    .toBe("a hi b");
  await expect(run(page, "intraword", "em")).toHaveCount(0);
  await expect
    .poll(() => text(page, "intraword").textContent())
    .toBe("call foo_bar_baz()");
  await expect(run(page, "kinds", "strong")).toHaveText("b");
  await expect(run(page, "kinds", "del")).toHaveText("s");
  await expect(run(page, "kinds", "u")).toHaveText("u");
  // All markers hidden while blurred.
  await expect.poll(() => text(page, "kinds").textContent()).toBe("b s u");
  await expect(run(page, "bold", "strong")).toHaveText("bold");
  await expect(run(page, "bold", "em")).toHaveCount(0);
  await expect(run(page, "triple", "strong")).toHaveText("x");
  // The visible text is "*x*" (one literal `*` on each side of the bold run).
  await expect.poll(() => text(page, "triple").textContent()).toBe("*x*");
  await expect(run(page, "unclosed", "em")).toHaveCount(0);
  await expect
    .poll(() => text(page, "unclosed").textContent())
    .toBe("*unclosed");
  await expect(run(page, "mixed", "em")).toHaveText("i");
  await expect(run(page, "mixed", "strong")).toHaveText("b");
});

test("caret reveals real markers, edits inside the fence, then refolds on blur", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "*italics*" },
    { id: "b", parentId: null, prevSiblingId: "n", text: "plain" },
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
  // Now place the caret at source offset 8 -- BETWEEN the interior and the
  // closing `*` (the `*italics|*` position Cam specified). If the marker were
  // a virtual/CSS pseudo-element this position would be unreachable; because
  // it is real text, typing here lands the char before the closing marker.
  await caretAtSource(page, "n", 8);
  await page.keyboard.type("Z");
  await expect.poll(() => text(page, "n").textContent()).toBe("*italicsZ*");
  // Still one bold... italic run -- the interior grew, the marker stayed put.
  await expect(run(page, "n", "em")).toHaveText("italicsZ");
  // Focus the sibling: the first run folds again (markers hidden).
  await text(page, "b").click();
  await expect.poll(() => text(page, "n").textContent()).toBe("italicsZ");
});

test("Cmd+B wraps a selection in **bold**", async ({ page }) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "alphabravo" },
  ]);
  await text(page, "n").click();
  await page.keyboard.press("ControlOrMeta+a"); // rung 1: native text select-all
  await page.keyboard.press("ControlOrMeta+b");
  await expect(run(page, "n", "strong")).toHaveText("alphabravo");
  // The browser's native bold (execCommand) must NOT have fired -- no stray
  // <b>; our source-level wrap produced a real `**...**` run.
  await expect(text(page, "n").locator("b")).toHaveCount(0);
});

test("/bold inserts empty markers with the caret inside", async ({ page }) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "" },
  ]);
  await text(page, "n").click();
  await page.keyboard.type("/bold");
  await page.keyboard.press("Enter");
  await page.keyboard.type("X");
  await expect(run(page, "n", "strong")).toHaveText("X");
});
