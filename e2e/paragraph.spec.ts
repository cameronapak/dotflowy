import { expect, test, type Page } from "@playwright/test";

import { placeCaret, seedOutline, text, type SeedNode } from "./fixtures";

// Paragraph nodes (ADR 0045): a third kind alongside bullet and task, signified
// by a paragraph glyph standing exactly where the bullet dot would -- same button, same
// zoom click, same drag. Kinds are mutually exclusive; `completed` is not a kind.
//
// The markdown round-trip and the MCP/OPML boundary are pure and unit-tested
// (markdown-import.test.ts, worker/outline-ops.test.ts); this spec locks zoom,
// the conversion funnels, and the Enter carry-forward.
//
// Every command here runs from an EMPTY bullet, so the `/` palette opens at
// offset 0 and no caret helper is needed (Home/End and `.click()` on text are
// unreliable in macOS Chromium contentEditable -- see CONTRIBUTING.md).

const TREE: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
  {
    id: "p",
    parentId: null,
    prevSiblingId: "a",
    text: "prose",
    kind: "paragraph",
  },
  // Empty bullets the conversion tests type into.
  { id: "e", parentId: null, prevSiblingId: "p", text: "" },
  { id: "et", parentId: null, prevSiblingId: "e", text: "", isTask: true },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"]`);
const dot = (page: Page, id: string) =>
  row(page, id).locator("> .outline-row .bullet-dot");
const paragraphGlyph = (page: Page, id: string) =>
  row(page, id).locator("> .outline-row .bullet-paragraph");
const checkbox = (page: Page, id: string) =>
  row(page, id).locator("> .outline-row .checkbox");

async function load(page: Page) {
  await seedOutline(page, TREE);
  await page.goto("/");
  await text(page, "a").waitFor({ state: "visible" });
}

/** Run a `/` command against the focused, empty bullet. */
async function runSlash(page: Page, command: string) {
  await page.keyboard.type(`/${command}`);
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Enter");
}

test("paragraph rows keep the zoom affordance without a checkbox", async ({
  page,
}) => {
  await load(page);
  await expect(paragraphGlyph(page, "p")).toBeVisible();
  await expect(dot(page, "p")).toHaveCount(0);
  await expect(dot(page, "a")).toBeVisible();
  await expect(paragraphGlyph(page, "a")).toHaveCount(0);
  // A paragraph is never a task, so it never wears a checkbox.
  await expect(checkbox(page, "p")).toHaveCount(0);

  await paragraphGlyph(page, "p").click();
  await expect(page).toHaveURL(/\/p$/);
  await expect(page.locator("h2.zoomed-title .node-text")).toHaveText("prose");
});

test("slash commands cycle bullet, paragraph, and task kinds exclusively", async ({
  page,
}) => {
  await load(page);
  await text(page, "e").click();
  await runSlash(page, "paragraph");
  await expect(paragraphGlyph(page, "e")).toBeVisible();

  await runSlash(page, "bullet");
  await expect(paragraphGlyph(page, "e")).toHaveCount(0);
  await expect(dot(page, "e")).toBeVisible();

  await runSlash(page, "paragraph");
  await expect(paragraphGlyph(page, "e")).toBeVisible();

  await runSlash(page, "todo");
  await expect(checkbox(page, "e")).toBeVisible();
  await expect(paragraphGlyph(page, "e")).toHaveCount(0);

  // Start from a persisted task as well as one just converted in this session.
  await expect(checkbox(page, "et")).toBeVisible();
  await text(page, "et").click();
  await runSlash(page, "paragraph");
  await expect(paragraphGlyph(page, "et")).toBeVisible();
  await expect(checkbox(page, "et")).toHaveCount(0);
});

test("Markdown markers and Backspace cycle kinds without losing text or children", async ({
  page,
}) => {
  await seedOutline(page, [
    {
      id: "p",
      parentId: null,
      prevSiblingId: null,
      text: "prose",
      kind: "paragraph",
    },
    { id: "child", parentId: "p", prevSiblingId: null, text: "keep child" },
    {
      id: "literal",
      parentId: null,
      prevSiblingId: "p",
      text: "-  literal",
      kind: "paragraph",
    },
  ]);
  await page.goto("/");
  await text(page, "p").waitFor({ state: "visible" });

  // A marker away from the beginning is ordinary prose.
  await placeCaret(text(page, "p"), "end");
  await page.keyboard.type("- ");
  await expect(paragraphGlyph(page, "p")).toBeVisible();
  await expect(text(page, "p")).toHaveText("prose- ");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");

  await placeCaret(text(page, "p"), 0);
  await page.keyboard.type("-");
  await expect(paragraphGlyph(page, "p")).toBeVisible();
  await page.keyboard.type(" ");
  await expect(dot(page, "p")).toBeVisible();
  await expect(paragraphGlyph(page, "p")).toHaveCount(0);
  await expect(text(page, "p")).toHaveText("prose");
  await page.keyboard.type("X");
  await expect(text(page, "p")).toHaveText("Xprose");

  // Backspace within text deletes text, not its kind.
  await page.keyboard.press("Backspace");
  await expect(dot(page, "p")).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(paragraphGlyph(page, "p")).toBeVisible();
  await expect(text(page, "p")).toHaveText("-prose");
  await expect(text(page, "p")).toBeFocused();
  await expect(row(page, "child")).toHaveAttribute("data-parent-id", "p");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(dot(page, "p")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/history.ts";
        return (await import(path)).getHistoryState().busy;
      }),
    )
    .toBe(false);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(paragraphGlyph(page, "p")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/history.ts";
        return (await import(path)).getHistoryState().busy;
      }),
    )
    .toBe(false);

  // The hyphen remains editable after redo; removing it keeps a paragraph.
  await page.keyboard.type(" ");
  await expect(dot(page, "p")).toBeVisible();
  await expect(text(page, "p")).toHaveText("prose");
  await page.keyboard.press("Backspace");
  await expect(text(page, "p")).toHaveText("-prose");
  await page.keyboard.press("Backspace");
  await expect(text(page, "p")).toHaveText("prose");
  await page.keyboard.type("[]");
  await expect(checkbox(page, "p")).toBeVisible();
  await expect(paragraphGlyph(page, "p")).toHaveCount(0);
  await expect(text(page, "p")).toHaveText("prose");
  await page.keyboard.press("Backspace");
  await expect(checkbox(page, "p")).toHaveCount(0);
  await expect(dot(page, "p")).toBeVisible();
  await expect(text(page, "p")).toHaveText("[ prose");
  await page.keyboard.type("]");
  await expect(checkbox(page, "p")).toBeVisible();
  await expect(text(page, "p")).toHaveText("prose");
  await page.keyboard.press("Backspace");
  await expect(text(page, "p")).toHaveText("[ prose");
  await page.keyboard.press("Backspace");
  await expect(text(page, "p")).toHaveText("[prose");
  await page.keyboard.press("Backspace");
  await expect(text(page, "p")).toHaveText("prose");
  await page.keyboard.press("Backspace");
  await expect(paragraphGlyph(page, "p")).toBeVisible();
  await expect(text(page, "p")).toHaveText("-prose");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("- [ ]");
  await expect(checkbox(page, "p")).toBeVisible();
  await expect(text(page, "p")).toHaveText("prose");
  await expect(row(page, "child")).toHaveAttribute("data-parent-id", "p");
  await page.reload();
  await text(page, "p").waitFor({ state: "visible" });
  await expect(checkbox(page, "p")).toBeVisible();
  await expect(text(page, "p")).toHaveText("prose");

  // Deleting into a pasted literal marker must not act like typing one.
  await placeCaret(text(page, "literal"), 3);
  await page.keyboard.press("Backspace");
  await expect(text(page, "literal")).toHaveText("- literal");
  await expect(paragraphGlyph(page, "literal")).toBeVisible();
});

test("Enter at the end of a paragraph makes another paragraph", async ({
  page,
}) => {
  await load(page);
  await text(page, "e").click();
  await runSlash(page, "paragraph");
  // Two paragraphs now: the seeded "prose" and the converted "e".
  await expect(page.locator(".outline-row .bullet-paragraph")).toHaveCount(2);

  // "e" is empty and childless, so the caret is at its end: Enter adds a
  // sibling, which inherits the kind exactly as `isTask` already does.
  await page.keyboard.press("Enter");
  await expect(page.locator(".outline-row .bullet-paragraph")).toHaveCount(3);
});

test("a paragraph is completable — `completed` is orthogonal to kind", async ({
  page,
}) => {
  await load(page);
  await text(page, "p").click();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(text(page, "p")).toHaveAttribute("data-completed", "true");
  // Still a paragraph, still no checkbox.
  await expect(paragraphGlyph(page, "p")).toBeVisible();
  await expect(checkbox(page, "p")).toHaveCount(0);
});
