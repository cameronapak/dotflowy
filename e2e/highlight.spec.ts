import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  text,
  type SeedNode,
} from "./fixtures";

// Highlight plugin (ADR 0035). `==text==` renders as a FOLDING token (the
// emphasis model): fences hidden while folded, revealed as real walk-through
// text when the caret is on the run. Color rides IN the source as an optional
// leading circle emoji (`==🔴urgent==`), hidden when folded; a bare run is
// blue. Right-click recolors by rewriting the emoji in the source.

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await openSeededOutline(page, { anchorId: tree[0]!.id });
}

const mark = (page: Page, id: string) => text(page, id).locator("mark");

// Drop the caret at a SOURCE offset within `id`'s text span (the emphasis
// spec's helper): a text node contributes its length; an ATOM (data-src)
// contributes its data-src-len and the caret snaps to its edge.
async function caretAtSource(page: Page, id: string, target: number) {
  await placeCaret(text(page, id), target);
}

test("a bare highlight keeps inner > literal while folding and revealing", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "a ==> hi== b" },
    { id: "plain", parentId: null, prevSiblingId: "n", text: "plain" },
  ]);
  await expect(mark(page, "n")).toHaveText("> hi");
  await expect(mark(page, "n")).toHaveAttribute("data-highlight", "blue");
  await expect(mark(page, "n")).toHaveAttribute("data-src", "==> hi==");
  await expect(mark(page, "n")).toHaveAttribute("contenteditable", "false");
  await expect.poll(() => text(page, "n").textContent()).toBe("a > hi b");

  await caretAtSource(page, "n", 10);
  await expect.poll(() => text(page, "n").textContent()).toBe("a ==> hi== b");
  await text(page, "plain").click();
  await expect.poll(() => text(page, "n").textContent()).toBe("a > hi b");
});

test("formatting inside a highlight survives editing, recoloring, and reload", async ({
  page,
}) => {
  const source =
    "before ==🔴More mature Christian *(Closer towards God)* **bold** ~~strike~~ ~underline~ _italic_ `*literal*` [link](https://example.com) #discipleship John 3:16 ||hidden text||== after";
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: source,
    },
    { id: "plain", parentId: null, prevSiblingId: "n", text: "plain" },
  ]);
  const highlight = mark(page, "n");
  await expect(highlight.locator("em")).toHaveText([
    "(Closer towards God)",
    "italic",
  ]);
  await expect(highlight.locator("strong")).toHaveText("bold");
  await expect(highlight.locator("del")).toHaveText("strike");
  await expect(highlight.locator("u")).toHaveText("underline");
  await expect(highlight.locator("code")).toHaveText("*literal*");
  await expect(highlight.locator("code em")).toHaveCount(0);
  await expect(highlight.locator("a")).toHaveText("link");
  await expect(highlight.locator('[data-tag="discipleship"]')).toHaveText(
    "#discipleship",
  );
  const bibleChip = highlight.locator("[data-bible-ref]");
  await expect(bibleChip).toHaveText("John 3:16");
  await expect(bibleChip.locator("svg")).toHaveCount(2);
  await expect(bibleChip).toHaveAttribute(
    "data-href",
    "https://route.bible/jhn.3.16?src=dotflowy",
  );

  // Typing outside the highlight must not remount its unchanged React chip.
  const mountedChip = await bibleChip.elementHandle();
  await caretAtSource(page, "n", source.length);
  await page.keyboard.type("!");
  await expect(text(page, "n")).toHaveAttribute("aria-label", `${source}!`);
  expect(await mountedChip!.evaluate((el) => el.isConnected)).toBe(true);

  // Enter from the atom's edge, then put the caret inside the italic run.
  await caretAtSource(page, "n", 7);
  await expect(highlight).toHaveAttribute("data-highlight-reveal", "");
  await caretAtSource(page, "n", 35);
  await expect(highlight.locator("em").first()).not.toHaveAttribute(
    "data-src",
    /.*/,
  );
  await caretAtSource(page, "n", 35);
  await page.keyboard.type("nearer ");
  await text(page, "plain").click();
  await expect(highlight.locator("em").first()).toHaveText(
    "(nearer Closer towards God)",
  );

  // Recolor through the revealed pen while inner tokens are folded. Reading
  // visible text here would lose their markers.
  await caretAtSource(page, "n", 7);
  await highlight.locator(".highlight-pen-icon").click();
  await page
    .locator("[data-highlight-menu]")
    .getByRole("menuitemradio", { name: "green" })
    .click();
  await expect(highlight).toHaveAttribute("data-highlight", "green");
  await expect(highlight).toHaveAttribute(
    "data-src",
    "==🟢More mature Christian *(nearer Closer towards God)* **bold** ~~strike~~ ~underline~ _italic_ `*literal*` [link](https://example.com) #discipleship John 3:16 ||hidden text||==",
  );
  await page.reload();
  await expect(text(page, "plain")).toBeVisible();
  await expect(highlight.locator("em").first()).toHaveText(
    "(nearer Closer towards God)",
  );
  await expect(highlight).toHaveAttribute("data-highlight", "green");
  await expect(highlight.locator("[data-spoiler]")).toHaveText(
    "||hidden text||",
  );
  await caretAtSource(page, "n", 7);
  // The earlier edit inserted seven source characters before the spoiler.
  const spoilerOffset = source.indexOf("||hidden text||") + 7 + 2;
  await caretAtSource(page, "n", spoilerOffset);
  await expect(highlight.locator("[data-spoiler-reveal]")).toHaveText(
    "||hidden text||",
  );
  await text(page, "plain").click();
  await expect(highlight.locator("[data-spoiler]")).toHaveText(
    "||hidden text||",
  );
  await expect(bibleChip.locator("svg")).toHaveCount(2);
  await bibleChip.click({ button: "right" });
  await expect(page.getByRole("combobox", { name: "Passage" })).toHaveValue(
    "John 3:16",
  );
  await page.keyboard.press("Escape");
  await highlight.locator('[data-tag="discipleship"]').click();
  await expect(page).toHaveURL(/q=%23discipleship/);
  await expect(text(page, "n")).toBeVisible();
});

test("a colored highlight folds, reveals, preserves its color through edits, and re-folds", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "==🔴urgent==" },
    { id: "plain", parentId: null, prevSiblingId: "n", text: "plain" },
  ]);
  await expect(mark(page, "n")).toHaveText("urgent");
  await expect(mark(page, "n")).toHaveAttribute("data-highlight", "red");
  // The emoji is not in the visible line -- the Lettera trick.
  await expect.poll(() => text(page, "n").textContent()).toBe("urgent");

  await text(page, "n").click();
  // Source length: 2 fences + 2 (emoji is one astral code point = 2 UTF-16
  // units) + 6 interior + 2 fences = 12.
  await caretAtSource(page, "n", 12);
  // The emoji is NEVER displayed -- the visible text is fences + interior;
  // the pen affordance carries the emoji as its atom source, so readSource
  // (and copy/export) still reconstructs `==🔴urgent==`.
  await expect.poll(() => text(page, "n").textContent()).toBe("==urgent==");
  await expect(text(page, "n").locator("[data-highlight-reveal]")).toHaveCount(
    1,
  );
  await expect(text(page, "n").locator(".highlight-pen-icon")).toHaveAttribute(
    "data-src",
    "🔴",
  );
  // Fences render INSIDE the painted <mark> (the code-box model).
  await expect(text(page, "n").locator("mark .md-punct")).toHaveCount(2);
  // The revealed <mark> itself is no longer an atom.
  await expect(mark(page, "n")).not.toHaveAttribute("data-src", /.*/);

  // Caret between the interior and the closing fence: `==🔴urgent|==`.
  await caretAtSource(page, "n", 10);
  await page.keyboard.type("!");
  await expect.poll(() => text(page, "n").textContent()).toBe("==urgent!==");
  // The pen atom carried the emoji through the edit -- still red.
  await expect(mark(page, "n")).toHaveAttribute("data-highlight", "red");
  await expect(text(page, "n").locator(".highlight-pen-icon")).toHaveAttribute(
    "data-src",
    "🔴",
  );

  await text(page, "plain").click();
  await expect.poll(() => text(page, "n").textContent()).toBe("urgent!");
  await expect(mark(page, "n")).toHaveAttribute("data-src", "==🔴urgent!==");
});

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

test("the context menu recolors a folded highlight, resets to blue, and removes it", async ({
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
  await expect.poll(() => text(page, "n").textContent()).toBe("a hi b");
  await expect(mark(page, "n")).toHaveAttribute("data-src", "==🔴hi==");

  await mark(page, "n").click({ button: "right" });
  await page
    .locator("[data-highlight-menu]")
    .getByRole("menuitemradio", { name: "blue" })
    .click();
  await expect(mark(page, "n")).toHaveAttribute("data-highlight", "blue");
  await expect(mark(page, "n")).toHaveAttribute("data-src", "==hi==");

  // Removal must strip a colored run's emoji too, not leak it into the text.
  await mark(page, "n").click({ button: "right" });
  await menu.getByRole("menuitemradio", { name: "green" }).click();
  await expect(mark(page, "n")).toHaveAttribute("data-src", "==🟢hi==");
  await mark(page, "n").click({ button: "right" });
  await page
    .locator("[data-highlight-menu]")
    .getByRole("menuitem", { name: "Remove highlight" })
    .click();
  await expect(mark(page, "n")).toHaveCount(0);
  await expect(text(page, "n")).toHaveText("a hi b");
});
