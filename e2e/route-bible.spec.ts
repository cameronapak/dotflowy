import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Route Bible plugin (ADR 0026): a Scripture reference in node.text renders as a
// non-folding chip (Seam A) that opens a passage edit popover on click (Seam B).
// Detection is liberal-regex-PROPOSES / grab-bcv-parser-DISPOSES, so a valid
// reference chips and a non-reference falls through to plain text. Unlike a rich
// link the chip does NOT fold/reveal -- its text equals its source whether
// focused or not.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

// The chip is the `<dotflowy-widget>` atom carrying data-bible-ref (ADR 0028).
const chip = (page: Page, id: string) =>
  text(page, id).locator("[data-bible-ref]");

async function load(page: Page, tree: SeedNode[]) {
  // Capture window.open so we can assert click-to-open without a real popup.
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

const passagePopover = (page: Page) =>
  page.locator("[data-bible-passage-popover]");

async function caretAtSource(page: Page, id: string, target: number) {
  await text(page, id).evaluate((el, target) => {
    el.focus();
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
        if (remaining <= len) {
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

const selectedBibleRef = (page: Page) =>
  page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount !== 1) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed || range.startContainer !== range.endContainer) return null;
    const node = range.startContainer.childNodes.item(range.startOffset);
    return node instanceof HTMLElement && node.hasAttribute("data-bible-ref")
      ? node.getAttribute("data-src")
      : null;
  });

test.describe("Scripture reference chips", () => {
  test("a chapter:verse reference chips with the resolver URL; a non-reference stays plain text", async ({
    page,
  }) => {
    await load(page, [
      { id: "ref", parentId: null, prevSiblingId: null, text: "Read John 3:16 today" },
      { id: "noref", parentId: null, prevSiblingId: "ref", text: "just some text 3" },
    ]);

    // The reference is a single chip showing its verbatim source...
    await expect(chip(page, "ref")).toHaveText("John 3:16");
    // ...linking to the canonical route.bible URL (lowercased OSIS + attribution).
    await expect(chip(page, "ref")).toHaveAttribute(
      "data-href",
      "https://route.bible/jhn.3.16?src=dotflowy",
    );

    // The chip is a real-TSX atomic widget (ADR 0028): the `<dotflowy-widget>`
    // custom element mounted BibleChip, so its lucide icons (the book + the
    // external-link SVGs) are present -- proof the React root rendered inside the
    // atom, not a serialized El string.
    await expect(chip(page, "ref").locator("svg")).toHaveCount(2);
    await expect(chip(page, "ref").locator("svg").first()).toBeVisible();

    // A book-like word + number that isn't a real reference never chips (the
    // parser gate rejects it).
    await expect(chip(page, "noref")).toHaveCount(0);
    await expect(text(page, "noref")).toHaveText("just some text 3");
  });

  test("a whole-chapter reference (no verse) also chips", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "See Genesis 1 for the start" },
    ]);

    await expect(chip(page, "n")).toHaveText("Genesis 1");
    await expect(chip(page, "n")).toHaveAttribute(
      "data-href",
      "https://route.bible/gen.1?src=dotflowy",
    );
  });

  test("multiple references on one line each chip independently", async ({
    page,
  }) => {
    await load(page, [
      {
        id: "n",
        parentId: null,
        prevSiblingId: null,
        text: "Compare John 3:16 with Romans 8:28",
      },
    ]);

    const chips = chip(page, "n");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveText("John 3:16");
    await expect(chips.nth(1)).toHaveText("Romans 8:28");
  });

  test("clicking a chip opens a passage editor with an Open action", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "1 Cor 13:4-7" },
    ]);

    await chip(page, "n").click();
    await expect(passagePopover(page)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Passage" })).toHaveValue(
      "1 Cor 13:4-7",
    );
    await page.getByRole("button", { name: "Open passage" }).click();

    expect(await opened(page)).toEqual([
      "https://route.bible/1co.13.4-7?src=dotflowy",
    ]);
  });

  test("the passage editor rewrites a chip through parsed input", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "Read John 3:16 today" },
    ]);

    await chip(page, "n").click();
    await page.getByRole("textbox", { name: "Passage" }).fill("rom 8:28");
    await expect(page.locator("[data-bible-passage-suggestions]")).toContainText(
      "Romans 8:28",
    );
    await page.getByRole("button", { name: "Done" }).click();

    await expect(text(page, "n")).toContainText("Read Romans 8:28 today");
    await expect(chip(page, "n")).toHaveText("Romans 8:28");
    await expect(chip(page, "n")).toHaveAttribute(
      "data-href",
      "https://route.bible/rom.8.28?src=dotflowy",
    );
  });

  test("Left/Right can select a chip and Enter opens it", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "See John 3:16 now" },
    ]);

    await caretAtSource(page, "n", "See ".length);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => selectedBibleRef(page)).toBe("John 3:16");
    await expect(chip(page, "n")).toHaveAttribute("data-atom-selected", "true");

    await page.keyboard.press("ArrowRight");
    await expect.poll(() => selectedBibleRef(page)).toBeNull();
    await expect(chip(page, "n")).not.toHaveAttribute("data-atom-selected", /.*/);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => selectedBibleRef(page)).toBe("John 3:16");
    await expect(chip(page, "n")).toHaveAttribute("data-atom-selected", "true");

    await page.keyboard.press("Enter");
    expect(await opened(page)).toEqual([
      "https://route.bible/jhn.3.16?src=dotflowy",
    ]);
  });
});
