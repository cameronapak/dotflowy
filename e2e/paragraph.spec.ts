import { expect, test, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Paragraph nodes (ADR 0045): a third kind alongside bullet and task, signified
// by a pilcrow standing exactly where the bullet dot would -- same button, same
// zoom click, same drag. Kinds are mutually exclusive; `completed` is not a kind.
//
// The markdown round-trip and the MCP/OPML boundary are pure and unit-tested
// (markdown-import.test.ts, worker/outline-ops.test.ts); this spec locks the two
// render paths, the conversion funnels, and the Enter carry-forward.
//
// Every command here runs from an EMPTY bullet, so the `/` palette opens at
// offset 0 and no caret helper is needed (Home/End and `.click()` on text are
// unreliable in macOS Chromium contentEditable -- see AGENTS.md).

const MOD = process.platform === "darwin" ? "Meta" : "Control";

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
const text = (page: Page, id: string) =>
  row(page, id).locator("> .outline-row .node-text");
const dot = (page: Page, id: string) =>
  row(page, id).locator("> .outline-row .bullet-dot");
const pilcrow = (page: Page, id: string) =>
  row(page, id).locator("> .outline-row .bullet-pilcrow");
const checkbox = (page: Page, id: string) =>
  row(page, id).locator("> .outline-row .checkbox");

/** `ready` is the locator that proves the view painted; zoomed views don't
 *  render the top-level rows, so the caller names its own. */
async function load(page: Page, path = "/", ready?: ReturnType<typeof text>) {
  await seedOutline(page, TREE);
  await page.goto(path);
  await expect(ready ?? text(page, "a")).toBeVisible();
}

/** Run a `/` command against the focused, empty bullet. */
async function runSlash(page: Page, command: string) {
  await page.keyboard.type(`/${command}`);
  await expect(page.locator('[role="listbox"]')).toBeVisible();
  await page.keyboard.press("Enter");
}

test.describe("paragraph nodes", () => {
  test("the pilcrow replaces the dot, and only for a paragraph", async ({
    page,
  }) => {
    await load(page);
    await expect(pilcrow(page, "p")).toBeVisible();
    await expect(dot(page, "p")).toHaveCount(0);
    await expect(dot(page, "a")).toBeVisible();
    await expect(pilcrow(page, "a")).toHaveCount(0);
    // A paragraph is never a task, so it never wears a checkbox.
    await expect(checkbox(page, "p")).toHaveCount(0);
  });

  test("the pilcrow sits on the dot's optical center, in the dot's column", async ({
    page,
  }) => {
    // ADR 0029's K-constants live on `.outline-row .bullet` (the 16px button),
    // and the pilcrow is centered inside that same button -- so it must land on
    // exactly the same baseline as a sibling row's dot. Numeric, not eyeballed:
    // a glyph swap that shifted the box would show up here.
    await load(page);
    const m = await page.evaluate(() => {
      const li = (id: string) =>
        document.querySelector(`li[data-node-id="${id}"]`)!;
      const centerY = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      };
      const centerX = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      };
      const textCenterY = (id: string) => {
        const span = li(id).querySelector(".node-text")!;
        const range = document.createRange();
        range.selectNodeContents(span.firstChild!);
        const line = range.getClientRects()[0]!;
        return line.top + line.height / 2;
      };
      return {
        dotOffset:
          centerY(li("a").querySelector(".bullet-dot")!) - textCenterY("a"),
        pilcrowOffset:
          centerY(li("p").querySelector(".bullet-pilcrow")!) - textCenterY("p"),
        dotX: centerX(li("a").querySelector(".bullet")!),
        pilcrowX: centerX(li("p").querySelector(".bullet")!),
      };
    });
    // Same vertical relationship to its own text as the dot has to its own.
    expect(Math.abs(m.pilcrowOffset - m.dotOffset)).toBeLessThan(1);
    // ...and the same column: the glyph swap must not move the button.
    expect(Math.abs(m.pilcrowX - m.dotX)).toBeLessThan(0.5);
  });

  test("the pilcrow still zooms on click, exactly like the dot", async ({
    page,
  }) => {
    await load(page);
    await pilcrow(page, "p").click();
    await expect(page).toHaveURL(/\/p$/);
    await expect(page.locator("h2.zoomed-title .node-text")).toHaveText(
      "prose",
    );
  });

  test("a zoomed paragraph shows a muted, inert pilcrow in the title", async ({
    page,
  }) => {
    await load(page, "/p", page.locator("h2.zoomed-title .node-text"));
    const mark = page.locator("h2.zoomed-title .title-pilcrow");
    await expect(mark).toBeVisible();
    await expect(mark).toHaveCSS("pointer-events", "none");

    // A zoomed BULLET shows nothing -- without the mark, the two would be
    // indistinguishable and `/paragraph` would have no visible state.
    await page.goto("/a");
    await expect(page.locator("h2.zoomed-title .node-text")).toHaveText(
      "alpha",
    );
    await expect(page.locator("h2.zoomed-title .title-pilcrow")).toHaveCount(0);
  });

  test("`/paragraph` converts a bullet; `/bullet` converts it back", async ({
    page,
  }) => {
    await load(page);
    await text(page, "e").click();
    await runSlash(page, "paragraph");
    await expect(pilcrow(page, "e")).toBeVisible();

    await runSlash(page, "bullet");
    await expect(pilcrow(page, "e")).toHaveCount(0);
    await expect(dot(page, "e")).toBeVisible();
  });

  test("`/paragraph` on a task clears the checkbox (kinds are exclusive)", async ({
    page,
  }) => {
    await load(page);
    await expect(checkbox(page, "et")).toBeVisible();
    await text(page, "et").click();
    await runSlash(page, "paragraph");
    await expect(pilcrow(page, "et")).toBeVisible();
    await expect(checkbox(page, "et")).toHaveCount(0);
  });

  test("`/todo` on a paragraph clears the pilcrow (the other direction)", async ({
    page,
  }) => {
    await load(page);
    await text(page, "e").click();
    await runSlash(page, "paragraph");
    await expect(pilcrow(page, "e")).toBeVisible();

    await runSlash(page, "todo");
    await expect(checkbox(page, "e")).toBeVisible();
    await expect(pilcrow(page, "e")).toHaveCount(0);
  });

  test("the `[]` autoformat converts a paragraph into a task", async ({
    page,
  }) => {
    await load(page);
    await text(page, "e").click();
    await runSlash(page, "paragraph");
    await expect(pilcrow(page, "e")).toBeVisible();

    await page.keyboard.type("[]");
    await expect(checkbox(page, "e")).toBeVisible();
    await expect(pilcrow(page, "e")).toHaveCount(0);
  });

  test("Enter at the end of a paragraph makes another paragraph", async ({
    page,
  }) => {
    await load(page);
    await text(page, "e").click();
    await runSlash(page, "paragraph");
    // Two paragraphs now: the seeded "prose" and the converted "e".
    await expect(page.locator(".outline-row .bullet-pilcrow")).toHaveCount(2);

    // "e" is empty and childless, so the caret is at its end: Enter adds a
    // sibling, which inherits the kind exactly as `isTask` already does.
    await page.keyboard.press("Enter");
    await expect(page.locator(".outline-row .bullet-pilcrow")).toHaveCount(3);
  });

  test("a paragraph is completable — `completed` is orthogonal to kind", async ({
    page,
  }) => {
    await load(page);
    await text(page, "p").click();
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(text(page, "p")).toHaveAttribute("data-completed", "true");
    // Still a paragraph, still no checkbox.
    await expect(pilcrow(page, "p")).toBeVisible();
    await expect(checkbox(page, "p")).toHaveCount(0);
  });
});
