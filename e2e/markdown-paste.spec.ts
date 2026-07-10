import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Markdown paste (ADR 0044): a multi-line paste builds a TREE of bullets, not
// one mashed line. The design is anchored on `parse(outlineToMarkdown(t)) === t`
// -- the grammar itself is property-tested in `src/data/markdown-import.test.ts`;
// these specs cover the behavior that only exists in a browser: the landing
// rules, the two render paths, undo, and the `Mod+Shift+V` literal hatch.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

/** Every rendered bullet as `depth:text`, in display order. */
async function rows(page: Page): Promise<string[]> {
  return page.locator("li[data-node-id]").evaluateAll((els) =>
    els.map((el) => {
      const depth = el.getAttribute("data-depth") ?? "?";
      const span = el.querySelector(".node-text");
      return `${depth}:${span?.textContent ?? ""}`;
    }),
  );
}

/** Dispatch a synthetic paste. The caret/selection must already be set. */
async function pasteInto(locator: Locator, plain: string) {
  await locator.evaluate((el, p) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", p);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, plain);
}

/** Focus a bullet and put the caret at source offset `col` (arrows and Home/End
 *  are unreliable in macOS Chromium contentEditable -- see AGENTS.md). */
async function caretAt(page: Page, id: string, col: number) {
  await text(page, id).evaluate((el, target) => {
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    const range = document.createRange();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
      node = walker.nextNode();
    }
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }, col);
}

const one: SeedNode[] = [{ id: "n", parentId: null, prevSiblingId: null, text: "" }];

test.describe("Structural markdown paste", () => {
  test("a multi-line paste becomes a tree, not one mashed line", async ({ page }) => {
    await load(page, one);
    await caretAt(page, "n", 0);
    await pasteInto(text(page, "n"), "alpha\n  bravo\n    charlie\ndelta");

    expect(await rows(page)).toEqual([
      "0:alpha",
      "1:bravo",
      "2:charlie",
      "0:delta",
    ]);
  });

  test("headings drive nesting; the shallowest normalizes to depth 0", async ({ page }) => {
    await load(page, one);
    await caretAt(page, "n", 0);
    await pasteInto(text(page, "n"), "## Intro\nbody\n### Detail\nmore");

    expect(await rows(page)).toEqual([
      "0:Intro",
      "1:body",
      "1:Detail",
      "2:more",
    ]);
  });

  test("task markers land as real checkboxes", async ({ page }) => {
    await load(page, one);
    await caretAt(page, "n", 0);
    await pasteInto(text(page, "n"), "- [ ] open\n- [x] done");

    const boxes = page.locator('li[data-node-id] input[type="checkbox"]');
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(0)).not.toBeChecked();
    await expect(boxes.nth(1)).toBeChecked();
    expect(await rows(page)).toEqual(["0:open", "0:done"]);
  });

  test("a bare `-` is an empty bullet, never a dropped line", async ({ page }) => {
    await load(page, one);
    await caretAt(page, "n", 0);
    await pasteInto(text(page, "n"), "- alpha\n-\n- bravo");

    expect(await rows(page)).toEqual(["0:alpha", "0:", "0:bravo"]);
  });

  test("fence delimiters survive as bullets and suppress the grammar", async ({ page }) => {
    await load(page, one);
    await caretAt(page, "n", 0);
    await pasteInto(page.locator('li[data-node-id="n"] .node-text'), "```ts\n- not a bullet\n```");

    expect(await rows(page)).toEqual(["0:```ts", "0:- not a bullet", "0:```"]);
  });

  test("head stays, tail welds onto the last inserted node, caret at the seam", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "keepEND" },
    ]);
    await caretAt(page, "n", 4); // between "keep" and "END"
    await pasteInto(text(page, "n"), "one\n  two");

    expect(await rows(page)).toEqual(["0:keepone", "1:twoEND"]);

    // The caret sits at the seam -- typing lands between "two" and "END".
    await page.keyboard.type("X");
    expect(await rows(page)).toEqual(["0:keepone", "1:twoXEND"]);
  });

  test("a task marker converts the anchor only when the caret leads the bullet", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "mid " },
    ]);
    await caretAt(page, "n", 4);
    await pasteInto(text(page, "n"), "- [x] done\nb");

    // Pasted mid-sentence: the anchor absorbs the text but stays a plain bullet.
    await expect(page.locator('li[data-node-id] input[type="checkbox"]')).toHaveCount(0);
    expect(await rows(page)).toEqual(["0:mid done", "0:b"]);
  });

  test("one Cmd+Z removes the whole paste", async ({ page }) => {
    await load(page, one);
    await caretAt(page, "n", 0);
    await pasteInto(text(page, "n"), "alpha\n  bravo\n    charlie\ndelta");
    expect(await rows(page)).toHaveLength(4);

    await page.keyboard.press("Meta+z");
    expect(await rows(page)).toEqual(["0:"]);
  });

  test("a single-line paste is untouched (the links plugin still wraps a URL)", async ({
    page,
  }) => {
    await load(page, one);
    await caretAt(page, "n", 0);
    // A trailing newline is a terminator, not a second line -- so this still
    // takes the Seam I chain and folds to a link.
    await pasteInto(text(page, "n"), "https://example.com\n");

    await expect(page.locator('li[data-node-id="n"] a')).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(await rows(page)).toHaveLength(1);
  });
});

test.describe("A paste never fights the view transforms", () => {
  // With hide-completed on, pasted `- [x]` lines arrive hidden -- exactly what
  // as-if-typed prescribes (completing a bullet hides it today). The paste must
  // not clear the transform; it discloses instead, because a paste that changes
  // nothing on screen is the one silent outcome (ADR 0044).
  test.beforeEach(async ({ page }) => {
    // Before navigation: showCompleted is read on the first render.
    await page.addInitScript(() =>
      window.localStorage.setItem("dotflowy:show-completed", "false"),
    );
  });

  test("bullets hidden by hide-completed still land, and say so", async ({ page }) => {
    await load(page, one);
    await caretAt(page, "n", 0);
    await pasteInto(text(page, "n"), "alpha\n- [x] done");

    expect(await rows(page)).toEqual(["0:alpha"]);
    await expect(page.getByText("hidden by the current view")).toBeVisible();
  });

  test("focus falls back to the last VISIBLE inserted bullet", async ({ page }) => {
    await load(page, one);
    await caretAt(page, "n", 0);
    await pasteInto(text(page, "n"), "alpha\nbravo\n- [x] done");

    // The seam ("done") is hidden, so the caret walks back to "bravo".
    expect(await rows(page)).toEqual(["0:alpha", "0:bravo"]);
    await page.keyboard.type("!");
    expect(await rows(page)).toEqual(["0:alpha", "0:bravo!"]);
  });
});

test.describe("The zoomed title (the two-render-paths exception)", () => {
  test("remaining roots become the title's prepended children", async ({ page }) => {
    await load(page, [
      { id: "root", parentId: null, prevSiblingId: null, text: "Root" },
      { id: "kid", parentId: "root", prevSiblingId: null, text: "existing" },
    ]);
    await page.goto("/root");
    const title = page.locator("h2.zoomed-title .node-text");
    await expect(title).toHaveText("Root");

    await title.evaluate((el: HTMLElement) => {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false); // caret at the end of "Root"
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    await pasteInto(title, "one\n  nested\ntwo");

    // Line 1 absorbs into the title; the rest are CHILDREN (a sibling of the
    // title lives outside the view and would vanish), before "existing".
    await expect(title).toHaveText("Rootone");
    expect(await rows(page)).toEqual(["0:nested", "0:two", "0:existing"]);
  });
});

test.describe("Mod+Shift+V pastes literal", () => {
  // The `paste` event carries no modifier keys, so the chord is read from the
  // preceding `keydown` (ProseMirror's technique). Chromium does fire keydown
  // before the paste it generates -- this test proves it, against the real
  // clipboard, so a browser change that reordered them would fail loudly.
  //
  // `keyboard.press("Meta+Shift+V")` cannot drive it: Playwright only attaches
  // an editing `command` to a handful of chords, and this is not one of them, so
  // the keydown lands and no paste is ever generated. The raw CDP event carries
  // the `pasteAndMatchStyle` command the browser itself would attach.
  async function pressLiteralPaste(page: Page, context: BrowserContext) {
    const cdp = await context.newCDPSession(page);
    const key = {
      modifiers: 8 | 4, // Shift | Meta
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
  }

  test("every line is one verbatim bullet, with no grammar and no link chip", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await load(page, one);
    await page.evaluate(() =>
      navigator.clipboard.writeText("- old\n+ new\nhttps://example.com"),
    );
    await caretAt(page, "n", 0);
    await pressLiteralPaste(page, context);

    // A diff pastes as a diff: `- old` / `+ new` are both CommonMark bullets.
    expect(await rows(page)).toEqual([
      "0:- old",
      "0:+ new",
      "0:https://example.com",
    ]);
    // Literal means literal: the URL is text, not a folded link.
    await expect(page.locator("li[data-node-id] a")).toHaveCount(0);
  });

  test("a single line splices verbatim, skipping the plugin chain", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await load(page, one);
    await page.evaluate(() => navigator.clipboard.writeText("https://example.com"));
    await caretAt(page, "n", 0);
    await pressLiteralPaste(page, context);

    // No line-count cliff: one promise, whatever the paste holds.
    expect(await rows(page)).toEqual(["0:https://example.com"]);
    await expect(page.locator("li[data-node-id] a")).toHaveCount(0);
  });

  test("a plain Cmd+V after it is NOT literal (the arm is one-shot)", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await load(page, one);
    await page.evaluate(() => navigator.clipboard.writeText("https://example.com"));
    await caretAt(page, "n", 0);

    await pressLiteralPaste(page, context);
    await expect(page.locator('li[data-node-id="n"] a')).toHaveCount(0);

    // Same bullet, same clipboard, caret still at the end -- only the chord
    // differs, and now the links plugin's Seam I wrap fires.
    await page.keyboard.press("Meta+V");
    await expect(page.locator('li[data-node-id="n"] a')).toHaveAttribute(
      "href",
      "https://example.com",
    );
  });
});
