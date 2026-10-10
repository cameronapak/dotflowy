import { expect, test, type Page } from "@playwright/test";

import { placeCaret, seedOutline, type SeedNode } from "./fixtures";

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
    // SAFETY: This init script owns these observation fields on its page's window.
    const state = window as typeof window & {
      __opened: string[];
      __focusedTabs: number;
    };
    state.__opened = [];
    state.__focusedTabs = 0;
    // SAFETY: The link opener only uses the returned tab's opener and focus method.
    window.open = ((url?: string | URL) => {
      state.__opened.push(String(url));
      return {
        opener: window,
        focus: () => {
          state.__focusedTabs += 1;
        },
      };
    }) as typeof window.open;
  });
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

const opened = (page: Page) =>
  page.evaluate(() => {
    // SAFETY: load's init script populates this field before the app runs.
    return (window as typeof window & { __opened: string[] }).__opened;
  });
const focusedTabs = (page: Page) =>
  page.evaluate(() => {
    // SAFETY: load's init script populates this field before the app runs.
    return (window as typeof window & { __focusedTabs: number }).__focusedTabs;
  });
const activeNodeId = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement
        ?.closest<HTMLElement>("[data-node-id]")
        ?.getAttribute("data-node-id") ?? null,
  );

async function caretAtSource(page: Page, id: string, target: number) {
  await placeCaret(text(page, id), target);
}

const passagePopover = (page: Page) =>
  page.locator("[data-bible-passage-popover]");

const selectedBibleRef = (page: Page) =>
  page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount !== 1) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed || range.startContainer !== range.endContainer)
      return null;
    const node = range.startContainer.childNodes.item(range.startOffset);
    return node instanceof HTMLElement && node.hasAttribute("data-bible-ref")
      ? node.getAttribute("data-src")
      : null;
  });

test("a chapter:verse reference chips with the resolver URL; a non-reference stays plain text", async ({
  page,
}) => {
  await load(page, [
    {
      id: "ref",
      parentId: null,
      prevSiblingId: null,
      text: "Read John 3:16 today",
    },
    {
      id: "noref",
      parentId: null,
      prevSiblingId: "ref",
      text: "just some text 3",
    },
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
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "See Genesis 1 for the start",
    },
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

test("clicking a chip opens its route.bible URL in a new tab", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "1 Cor 13:4-7" },
  ]);

  await chip(page, "n").click();

  expect(await opened(page)).toEqual([
    "https://route.bible/1co.13.4-7?src=dotflowy",
  ]);
  expect(await focusedTabs(page)).toBe(1);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => activeNodeId(page)).toBe("n");
});

test("holding a chip opens the passage editor", async ({ page }) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "1 Cor 13:4-7" },
  ]);

  const box = await chip(page, "n").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  // Keep the pointer held until the long-press timer opens the editor.
  await expect(passagePopover(page)).toBeVisible();
  await page.mouse.up();

  await expect(passagePopover(page)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Passage" })).toHaveValue(
    "1 Cor 13:4-7",
  );
  expect(await opened(page)).toEqual([]);
});

test("the passage editor rewrites a chip through parsed input", async ({
  page,
}) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "Read John 3:16 today",
    },
  ]);

  await chip(page, "n").click({ button: "right" });
  await page.getByRole("combobox", { name: "Passage" }).fill("rom 8:28");
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

test("the passage editor hides end verse until a start verse exists", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "Read Proverbs 4" },
  ]);

  await chip(page, "n").click({ button: "right" });
  await passagePopover(page).locator("summary").click();
  await expect(page.getByRole("combobox", { name: "End verse" })).toHaveCount(
    0,
  );

  await page.getByRole("combobox", { name: "Start verse" }).selectOption("13");

  await expect(page.getByRole("combobox", { name: "End verse" })).toBeVisible();
});

test("closing the passage editor refocuses the node", async ({ page }) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "Read John 3:16 today",
    },
  ]);

  await chip(page, "n").click({ button: "right" });
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect.poll(() => activeNodeId(page)).toBe("n");
});

test("the passage autocomplete supports keyboard selection", async ({
  page,
}) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "Read John 3:16 today",
    },
  ]);

  await chip(page, "n").click({ button: "right" });
  const input = page.getByRole("combobox", { name: "Passage" });
  await input.fill("rom 8");
  await expect(page.getByRole("option", { name: /Romans 8/ })).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("Romans 8");
});

test("Space on a hovered chip opens the passage editor", async ({ page }) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "See John 3:16 now",
    },
  ]);

  await caretAtSource(page, "n", 0);
  const box = await chip(page, "n").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.press("Space");

  await expect(passagePopover(page)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Passage" })).toHaveValue(
    "John 3:16",
  );
  expect(await opened(page)).toEqual([]);
});

test("Left/Right can select a chip and Enter opens it", async ({ page }) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "See John 3:16 now",
    },
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

test("Mod+Enter after a chip opens and focuses its route.bible URL", async ({
  page,
}) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "See John 3:16 now",
    },
  ]);

  await caretAtSource(page, "n", "See John 3:16".length);
  await page.keyboard.press("ControlOrMeta+Enter");

  expect(await opened(page)).toEqual([
    "https://route.bible/jhn.3.16?src=dotflowy",
  ]);
  expect(await focusedTabs(page)).toBe(1);
});

test("Mod-click after a chip opens and focuses its route.bible URL", async ({
  page,
}) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "See John 3:16 now",
    },
  ]);

  await placeCaret(text(page, "n"), "See John 3:16".length);
  await text(page, "n").evaluate((el: HTMLElement) => {
    el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      }),
    );
  });

  expect(await opened(page)).toEqual([
    "https://route.bible/jhn.3.16?src=dotflowy",
  ]);
  expect(await focusedTabs(page)).toBe(1);
});
