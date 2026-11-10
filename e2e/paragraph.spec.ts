import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  text,
  type SeedNode,
} from "./fixtures";

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
  // The visible conversion is optimistic; reload only after the server has it.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const nodes = await (await fetch("/api/nodes")).json();
        const node = nodes.find((n: { id: string }) => n.id === "p");
        return { text: node.text, isTask: node.isTask, kind: node.kind };
      }),
    )
    .toEqual({ text: "prose", isTask: true, kind: null });
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

test("numbered typing, splitting, exiting, marker reveal, and undo keep node identity", async ({
  page,
}) => {
  await seedOutline(page, [
    {
      id: "p",
      parentId: null,
      prevSiblingId: null,
      text: "First thought",
      kind: "paragraph",
    },
    { id: "child", parentId: "p", prevSiblingId: null, text: "child" },
    { id: "b", parentId: null, prevSiblingId: "p", text: "Second thought" },
    {
      id: "literal",
      parentId: null,
      prevSiblingId: "b",
      text: "1.  literal",
      kind: "paragraph",
    },
  ]);
  await page.goto("/");
  await placeCaret(text(page, "p"), "start");
  await page.keyboard.type("1.");
  await expect(paragraphGlyph(page, "p")).toBeVisible();
  await page.keyboard.type(" ");
  await expect(row(page, "p").locator(".bullet-number")).toHaveText("1.");
  await expect(text(page, "p")).toHaveText("First thought");
  await expect(row(page, "child")).toHaveAttribute("data-parent-id", "p");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(paragraphGlyph(page, "p")).toBeVisible();
  // Undo restores the state before the space insertion that converted Kind.
  await expect(text(page, "p")).toHaveText("1.First thought");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/history.ts";
        return (await import(path)).getHistoryState().busy;
      }),
    )
    .toBe(false);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(row(page, "p").locator(".bullet-number")).toHaveText("1.");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/history.ts";
        return (await import(path)).getHistoryState().busy;
      }),
    )
    .toBe(false);

  await placeCaret(text(page, "b"), "start");
  await page.keyboard.type("1. ");
  await expect(row(page, "b").locator(".bullet-number")).toHaveText("2.");
  await expect(text(page, "b")).toHaveText("Second thought");
  await placeCaret(text(page, "b"), "start");
  await page.keyboard.press("Backspace");
  await expect(paragraphGlyph(page, "b")).toBeVisible();
  await expect(text(page, "b")).toHaveText("2.Second thought");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "b").locator(".bullet-number")).toHaveText("2.");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/data/history.ts";
        return (await import(path)).getHistoryState().busy;
      }),
    )
    .toBe(false);

  // Numbered Enter creates a sibling even when the item has expanded children.
  await placeCaret(text(page, "p"), "end");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Middle");
  const middle = page
    .locator('.outline-row .node-text[data-kind="numbered"]')
    .filter({ hasText: /^Middle$/ });
  await expect(middle.locator("xpath=ancestor::li[1]")).not.toHaveAttribute(
    "data-parent-id",
  );
  await expect(row(page, "b").locator(".bullet-number")).toHaveText("3.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Outside list");
  await expect(
    page
      .locator('.outline-row .node-text[data-kind="paragraph"]')
      .filter({ hasText: /^Outside list$/ }),
  ).toBeVisible();
  await expect(row(page, "b").locator(".bullet-number")).toHaveText("1.");

  // Deleting into a literal marker must not trigger conversion.
  await placeCaret(text(page, "literal"), 4);
  await page.keyboard.press("Backspace");
  await expect(paragraphGlyph(page, "literal")).toBeVisible();
  await expect(text(page, "literal")).toHaveText("1. literal");
  await page.reload();
  await expect(row(page, "b").locator(".bullet-number")).toHaveText("1.");
  await expect(text(page, "p")).toHaveText("First thought");
  await placeCaret(text(page, "b"), 6);
  await page.keyboard.press("Enter");
  await expect(text(page, "b")).toHaveText("Second");
  await expect(
    page
      .locator('.outline-row .node-text[data-kind="numbered"]')
      .filter({ hasText: /^ thought$/ }),
  ).toBeVisible();
  await expect(row(page, "b").locator(".bullet-number")).toHaveText("1.");
});

test("number handles renumber after moves, zoom, and preserve quote editing", async ({
  page,
}) => {
  await seedOutline(page, [
    {
      id: "a",
      parentId: null,
      prevSiblingId: null,
      text: "Alpha",
      kind: "numbered",
    },
    {
      id: "b",
      parentId: null,
      prevSiblingId: "a",
      text: "Bravo",
      kind: "numbered",
    },
    {
      id: "c",
      parentId: null,
      prevSiblingId: "b",
      text: "> Charlie",
      kind: "numbered",
    },
    {
      id: "nested",
      parentId: "c",
      prevSiblingId: null,
      text: "Nested",
      kind: "numbered",
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `item-${i + 4}`,
      parentId: null,
      prevSiblingId: i === 0 ? "c" : `item-${i + 3}`,
      text: `Item ${i + 4}`,
      kind: "numbered" as const,
    })),
    {
      id: "plain",
      parentId: null,
      prevSiblingId: "item-12",
      text: "Plain bullet",
    },
    {
      id: "prose",
      parentId: null,
      prevSiblingId: "plain",
      text: "Prose",
      kind: "paragraph",
    },
    {
      id: "quote",
      parentId: null,
      prevSiblingId: "prose",
      text: "> Quotation",
    },
  ]);
  await openSeededOutline(page, { anchorId: "c" });
  await expect(row(page, "c").locator(".bullet-number")).toHaveText("3.");
  await expect(row(page, "c").locator(".bullet-quote")).toHaveCount(0);
  await expect(row(page, "nested").locator(".bullet-number")).toHaveText("1.");
  await expect(row(page, "item-10").locator(".bullet-number")).toHaveText(
    "10.",
  );
  const markerColor = (id: string) =>
    row(page, id)
      .locator(".bullet-number")
      .evaluate((el) => getComputedStyle(el).color);
  const idleMarker = await markerColor("b");
  const idleText = await text(page, "b").evaluate(
    (el) => getComputedStyle(el).color,
  );
  await placeCaret(text(page, "a"), "end");
  await expect.poll(() => markerColor("b")).not.toBe(idleMarker);
  expect(
    await text(page, "b").evaluate((el) => getComputedStyle(el).color),
  ).toBe(idleText);
  await placeCaret(text(page, "b"), "end");
  await expect.poll(() => markerColor("b")).toBe(idleMarker);
  await expect.poll(() => markerColor("a")).not.toBe(idleMarker);
  const single = await row(page, "a").locator(".bullet-number").boundingBox();
  const double = await row(page, "item-10")
    .locator(".bullet-number")
    .boundingBox();
  expect(
    Math.abs(single!.x + single!.width - double!.x - double!.width),
  ).toBeLessThan(0.5);
  const singleText = await text(page, "a").boundingBox();
  const doubleText = await text(page, "item-10").boundingBox();
  expect(Math.abs(singleText!.x - doubleText!.x)).toBeLessThan(0.5);
  for (const id of ["plain", "prose", "quote"]) {
    const box = await text(page, id).boundingBox();
    expect(Math.abs(singleText!.x - box!.x)).toBeLessThan(0.5);
  }
  const handle = await row(page, "item-10").locator(".bullet").boundingBox();
  const singleHandle = await row(page, "a").locator(".bullet").boundingBox();
  expect(singleHandle!.width).toBeLessThan(handle!.width);
  const hitHeight = await row(page, "a")
    .locator(".bullet")
    .evaluate((el) => parseFloat(getComputedStyle(el, "::before").height));
  expect(hitHeight).toBeLessThanOrEqual(singleHandle!.height);
  const fontSize = await text(page, "item-10").evaluate(
    (el) => getComputedStyle(el).fontSize,
  );
  await row(page, "item-10")
    .getByRole("button", { name: "Zoom into item 10" })
    .click();
  await expect(page.locator(".title-number")).toHaveText("10.");
  await page.waitForFunction(
    () => !document.documentElement.matches(":active-view-transition"),
  );
  const titleText = await page
    .getByRole("textbox", { name: "Title", exact: true })
    .boundingBox();
  const titleMarker = await page.locator(".title-number").boundingBox();
  expect(Math.abs(titleText!.x - doubleText!.x)).toBeLessThan(0.5);
  expect(
    Math.abs(titleMarker!.x + titleMarker!.width - handle!.x - handle!.width),
  ).toBeLessThan(0.5);
  const titleFontSize = await page
    .getByRole("textbox", { name: "Title", exact: true })
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(parseFloat(titleFontSize)).toBeGreaterThan(parseFloat(fontSize));
  expect(
    await page
      .locator(".title-number")
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe(titleFontSize);
  await openSeededOutline(page, { anchorId: "c" });
  await placeCaret(text(page, "b"), "end");
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
  await expect(row(page, "b").locator(".bullet-number")).toHaveText("1.");
  await expect(row(page, "a").locator(".bullet-number")).toHaveText("2.");
  await expect(text(page, "b")).toHaveText("Bravo");
  await placeCaret(text(page, "c"), "start");
  await page.keyboard.press("Backspace");
  await expect(text(page, "c")).toHaveText("Charlie");
  await expect(row(page, "c").locator(".bullet-number")).toHaveText("3.");
  await row(page, "c")
    .getByRole("button", { name: "Zoom into item 3" })
    .click();
  await expect(page).toHaveURL(/\/c$/);
  await expect(page.locator(".zoomed-title .title-number")).toHaveText("3.");
  await expect(row(page, "nested").locator(".bullet-number")).toHaveText("1.");
  await page.reload();
  await expect(page.locator(".zoomed-title .title-number")).toHaveText("3.");
});

test("numbering retains hidden siblings and invalidates mirror runs when source Kind changes", async ({
  page,
}) => {
  await seedOutline(page, [
    {
      id: "source",
      parentId: null,
      prevSiblingId: null,
      text: "keep source",
      kind: "numbered",
    },
    {
      id: "hidden",
      parentId: null,
      prevSiblingId: "source",
      text: "omit",
      kind: "numbered",
      completed: true,
    },
    {
      id: "last",
      parentId: null,
      prevSiblingId: "hidden",
      text: "keep last",
      kind: "numbered",
    },
    {
      id: "parent",
      parentId: null,
      prevSiblingId: "last",
      text: "keep parent",
    },
    {
      id: "mirror",
      parentId: "parent",
      prevSiblingId: null,
      text: "",
      mirrorOf: "source",
    },
    {
      id: "after",
      parentId: "parent",
      prevSiblingId: "mirror",
      text: "keep after",
      kind: "numbered",
    },
  ]);
  await page.goto("/?q=keep");
  await expect(row(page, "hidden")).toHaveCount(0);
  await expect(row(page, "last").locator(".bullet-number")).toHaveText("3.");
  await expect(row(page, "mirror").locator(".bullet-number")).toHaveText("1.");
  await expect(row(page, "after").locator(".bullet-number")).toHaveText("2.");
  await placeCaret(text(page, "source"), "start");
  await page.keyboard.press("Backspace");
  await expect(paragraphGlyph(page, "source")).toBeVisible();
  await expect(paragraphGlyph(page, "mirror")).toBeVisible();
  await expect(row(page, "last").locator(".bullet-number")).toHaveText("2.");
  await expect(row(page, "after").locator(".bullet-number")).toHaveText("1.");
});
