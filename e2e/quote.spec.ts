import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  text,
  type SeedNode,
} from "./fixtures";

// Quotes (ADR 0079): a node whose text starts with `> ` is a quote. The marker
// folds away, a bar replaces the dot as the zoom target, Enter carries the
// marker forward, and Backspace at or inside it unquotes the row. The parser
// side (a pasted blockquote keeps `> `) is unit-tested in
// markdown-import.test.ts.

const LONG =
  "> Simple tools invite careful thought. When the structure stays out of the way, the writing gets better and the outline stays honest.";

const TREE: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
  { id: "q", parentId: null, prevSiblingId: "a", text: LONG },
  { id: "src", parentId: "q", prevSiblingId: null, text: "Source: page 12" },
  { id: "e", parentId: null, prevSiblingId: "q", text: "" },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);
const bar = (page: Page, id: string) => row(page, id).locator(".bullet-quote");

/** Each top-level row's TEXT SOURCE, in order: folded atoms read as their
 *  `data-src`, so a quote reads back with its `> `. */
function sources(page: Page): Promise<string[]> {
  return page
    .locator('li[data-node-id][data-depth="0"] > .outline-row .node-text')
    .evaluateAll((els) =>
      els.map((el) =>
        [...el.childNodes]
          .map((n) =>
            n instanceof HTMLElement && n.dataset.src !== undefined
              ? n.dataset.src
              : (n.textContent ?? ""),
          )
          .join(""),
      ),
    );
}

test("a stored `> ` renders as a quote whose bar zooms", async ({ page }) => {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "q" });

  // Existing text needs no migration: the marker folds, the bar replaces the
  // dot, and the plain row keeps its dot.
  await expect(text(page, "q")).toHaveText(LONG.slice(2));
  await expect(bar(page, "q")).toBeVisible();
  await expect(row(page, "q").locator(".bullet-dot")).toHaveCount(0);
  await expect(row(page, "a").locator(".bullet-dot")).toBeVisible();
  await expect(bar(page, "src")).toHaveCount(0);

  // The bar is the zoom target, and the zoomed title keeps a bar of its own.
  await row(page, "q").getByRole("button", { name: "Zoom in" }).click();
  await expect(page).toHaveURL(/\/q$/);
  await expect(page.locator("h2.zoomed-title .title-quote")).toBeVisible();
  await expect(page.locator("h2.zoomed-title .node-text")).toHaveText(
    LONG.slice(2),
  );
});

test("typing `> ` quotes a row, Enter carries it, Backspace removes it", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await openSeededOutline(page, { anchorId: "e" });

  // Backspace right after a fresh marker turns the row back into a bullet.
  await placeCaret(text(page, "e"), "end");
  await page.keyboard.type("> ");
  await expect(bar(page, "e")).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(bar(page, "e")).toHaveCount(0);
  await expect(text(page, "e")).toHaveText("");

  // Enter on a quote starts the next row with `> `, caret after it; Enter on
  // that empty quote unquotes it in place instead of adding a row.
  await page.keyboard.type("> first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("plain");

  // Backspace at the very start of a quote unquotes it rather than joining it
  // into the row above (ADR 0059's join).
  const second = page.locator(
    'li[data-node-id][data-depth="0"] > .outline-row .node-text',
    { hasText: "second" },
  );
  await placeCaret(second, "start");
  await page.keyboard.press("Backspace");
  await expect
    .poll(() => sources(page))
    .toEqual(["alpha", LONG, "> first", "second", "plain"]);

  // The server holds the same text, marker and all.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const nodes: { text: string }[] = await (
          await fetch("/api/nodes")
        ).json();
        return nodes.map((n) => n.text).sort();
      }),
    )
    .toEqual(
      ["alpha", LONG, "Source: page 12", "> first", "second", "plain"].sort(),
    );
});

test("Backspace leaves a locked quote's marker in place", async ({ page }) => {
  await seedOutline(page, [
    ...TREE,
    {
      id: "lq",
      parentId: null,
      prevSiblingId: "e",
      text: "> Locked words",
      locked: true,
    },
  ]);
  await openSeededOutline(page, { anchorId: "lq" });

  // A locked row is focusable but not editable, so the unquote must not
  // repaint text the protection guard refuses to write.
  await placeCaret(text(page, "lq"), "start");
  await page.keyboard.press("Backspace");
  await expect.poll(() => sources(page)).toContain("> Locked words");
  await expect(bar(page, "lq")).toBeVisible();
});

test.describe("on a coarse pointer", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 412, height: 900 },
  });

  test("the bar keeps the 24px column and spans the quote's lines", async ({
    page,
  }) => {
    await seedOutline(page, TREE);
    await openSeededOutline(page, { anchorId: "q" });

    const target = row(page, "q").getByRole("button", { name: "Zoom in" });
    const box = (await target.boundingBox())!;
    const lines = (await text(page, "q").boundingBox())!;
    // Same width as every other coarse bullet, so it cannot crowd the
    // chevron or the caret; as tall as the wrapped quote, less its padding.
    expect(box.width).toBe(24);
    expect(box.height).toBeGreaterThan(48);
    expect(Math.abs(box.height - (lines.height - 6))).toBeLessThanOrEqual(1);

    await target.tap();
    await expect(page).toHaveURL(/\/q$/);
  });
});
